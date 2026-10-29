//! Silence cleanup edits the live timeline. Archived analysis supplies evidence,
//! never replacement footage or an assembly snapshot to restore.
use super::*;

type Range = (i64, i64);
fn bounds(e: &Value) -> Result<Range, CapabilityError> {
    let s = tick(&e["startTime"])?;
    Ok((s, s + tick(&e["duration"])?))
}
fn merge(mut ranges: Vec<Range>) -> Vec<Range> {
    ranges.sort_unstable();
    let mut joined: Vec<Range> = vec![];
    for (a, b) in ranges {
        if a >= b {
            continue;
        }
        if let Some(last) = joined.last_mut().filter(|last| a <= last.1) {
            last.1 = last.1.max(b);
        } else {
            joined.push((a, b));
        }
    }
    joined
}
fn retained(from: i64, to: i64, cuts: &[Range]) -> Vec<Range> {
    let mut cursor = from;
    let mut result = vec![];
    for &(a, b) in cuts {
        if b <= cursor || a >= to {
            continue;
        }
        if a > cursor {
            result.push((cursor, a.min(to)));
        }
        cursor = cursor.max(b).min(to);
    }
    if cursor < to {
        result.push((cursor, to));
    }
    result
}
fn mapped(time: i64, cuts: &[Range]) -> i64 {
    time - cuts
        .iter()
        .map(|&(a, b)| (time.min(b) - a).max(0))
        .sum::<i64>()
}

pub(super) fn apply(
    assembly: &Assembly,
    scene: &Value,
    groups: Option<&[usize]>,
    ids: Option<&[String]>,
    minimum: f64,
    fresh: &mut dyn FnMut() -> String,
    context: &InvocationContext,
) -> Result<(Value, Value), CapabilityError> {
    let before = &scene["tracks"];
    let selected = |e: &Value| {
        e["takeGroup"]["assemblyId"] == assembly.id
            && e["takeGroup"]["groupIndex"]
                .as_u64()
                .is_some_and(|i| groups.is_none_or(|g| g.contains(&(i as usize))))
            && ids.is_none_or(|ids| ids.iter().any(|id| e["id"] == *id))
    };
    if let Some(ids) = ids {
        if ids.is_empty()
            || ids.iter().collect::<HashSet<_>>().len() != ids.len()
            || ids.iter().any(|id| {
                !arr(&before["main"]["elements"])
                    .iter()
                    .any(|e| e["id"] == *id && selected(e))
            })
        {
            return Err(invalid(
                "Silence cleanup must target surviving clips in the selected take groups",
            ));
        }
    }
    // Protect both the live transcript and authored/corrected word clocks.
    let padding = (0.12 * TPS) as i64;
    let mut protected = vec![];
    for track in all(before) {
        for word in arr(&track["captionSource"]["words"]) {
            let (a, b) = word_times(word)?;
            protected.push(((a - padding).max(0), b + padding));
        }
        for e in arr(&track["elements"]) {
            let (a, b) = bounds(e)?;
            if e["type"] == "text" && !arr(&e["wordRuns"]).is_empty() {
                for (_, s, end, _) in classic_text::timed_words(e)? {
                    protected.push(((a + s - padding).max(0), a + end + padding));
                }
            }
            // A selected camera must never erase another, unselected camera.
            if e["type"] == "video" && !selected(e) {
                protected.push((a, b));
            }
        }
    }
    let protected = merge(protected);
    let mut cuts = vec![];
    for live in arr(&before["main"]["elements"])
        .iter()
        .filter(|e| selected(e))
    {
        if context.cancellation.is_cancelled() {
            return Err(CapabilityError::Failed("Silence cleanup cancelled".into()));
        }
        let (ls, le) = bounds(live)?;
        let rate = classic_update::rate(live);
        let trim = tick(&live["trimStart"])? as f64;
        for gap in &assembly.audio_gaps {
            let Some(source) = arr(&assembly.source_tracks["main"]["elements"])
                .iter()
                .find(|e| {
                    e["id"] == gap.clip_id
                        && e["mediaId"] == live["mediaId"]
                        && e["type"] == live["type"]
                        && ["sourceAudioOffsetSeconds", "audioSyncOffset"]
                            .iter()
                            .all(|key| e["params"][key] == live["params"][key])
                })
            else {
                continue;
            };
            let source_start = tick(&source["startTime"])?;
            let source_trim = tick(&source["trimStart"])? as f64;
            let source_rate = classic_update::rate(source);
            for &(a, b) in &gap.ranges {
                // Evidence clocks are archived timeline clocks; map through the
                // physical media source into this surviving occurrence's clock.
                let to_live = |t: i64| {
                    ls + ((source_trim + (t - source_start) as f64 * source_rate - trim) / rate)
                        .round() as i64
                };
                let a = to_live(a).max(ls);
                let b = to_live(b).min(le);
                for (a, b) in retained(a, b, &protected) {
                    if b - a >= (minimum * TPS).ceil() as i64 {
                        cuts.push((a, b));
                    }
                }
            }
        }
    }
    let cuts = merge(cuts);
    if cuts.is_empty() {
        return Ok((before.clone(), scene["bookmarks"].clone()));
    }
    let mut tracks = before.clone();
    let mut splice = |track: &mut Value| -> Result<(), CapabilityError> {
        let original = track.clone();
        let mut elements = vec![];
        for e in arr(&original["elements"]) {
            let (s, end) = bounds(e)?;
            let spans = retained(s, end, &cuts);
            if spans == [(s, end)] {
                let mut e = e.clone();
                e["startTime"] = json!(mapped(s, &cuts));
                elements.push(e);
                continue;
            }
            let mut first = true;
            for (a, b) in spans {
                let piece = if e["type"] == "text" && !arr(&e["wordRuns"]).is_empty() {
                    replacement::crop(e, a, b, mapped(a, &cuts), fresh)?
                } else {
                    Some(slice(e, a, b, mapped(a, &cuts), fresh)?)
                };
                if let Some(mut piece) = piece {
                    if first {
                        piece["id"] = e["id"].clone();
                        first = false;
                    }
                    elements.push(piece);
                }
            }
        }
        track["elements"] = json!(elements);
        for w in track
            .get_mut("captionSource")
            .and_then(|s| s.get_mut("words"))
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            let (a, b) = word_times(w)?;
            w["start"] = json!(mapped(a, &cuts) as f64 / TPS);
            w["end"] = json!(mapped(b, &cuts) as f64 / TPS);
        }
        if original["locked"] == true && original != *track {
            return Err(invalid(
                "Silence cleanup would change a locked track. Unlock it first",
            ));
        }
        Ok(())
    };
    splice(&mut tracks["main"])?;
    for key in ["overlay", "audio"] {
        for t in tracks[key].as_array_mut().into_iter().flatten() {
            splice(t)?;
        }
    }
    let mut bookmarks = scene["bookmarks"].clone();
    for b in bookmarks.as_array_mut().into_iter().flatten() {
        let t = tick(&b["time"])?;
        if let Some(d) = b["duration"].as_i64() {
            b["duration"] = json!(mapped(t + d, &cuts) - mapped(t, &cuts));
        }
        b["time"] = json!(mapped(t, &cuts));
    }
    Ok((tracks, bookmarks))
}
