//! Replace only surviving occurrences. The archive is a source library, never a snapshot
//! to restore over an editor's later cuts, deletions, captions or reordered clips.
use super::*;

#[derive(Clone)]
struct Edit {
    element_id: String,
    from: i64,
    to: i64,
    old_from: i64,
    new_from: i64,
    new_to: i64,
    dest: i64,
    speed: f64,
}
impl Edit {
    fn duration(&self) -> i64 {
        ((self.new_to - self.new_from) as f64 / self.speed).round() as i64
    }
    fn new_time(&self, time: i64) -> i64 {
        self.dest + ((time - self.new_from) as f64 / self.speed).round() as i64
    }
}
fn bounds(e: &Value) -> Result<(i64, i64), CapabilityError> {
    let s = tick(&e["startTime"])?;
    Ok((s, s + tick(&e["duration"])?))
}
fn belongs(e: &Value, assembly: &Assembly, group: usize) -> bool {
    e["takeGroup"]["assemblyId"] == assembly.id
        && e["takeGroup"]["groupIndex"].as_u64() == Some(group as u64)
}
fn group_bounds(tracks: &Value, a: &Assembly, group: usize) -> Result<(i64, i64), CapabilityError> {
    let mut spans = arr(&tracks["main"]["elements"])
        .iter()
        .filter(|e| belongs(e, a, group))
        .map(bounds);
    let (mut start, mut end) = spans
        .next()
        .ok_or_else(|| invalid("The selected take has no surviving video"))??;
    for span in spans {
        let (s, e) = span?;
        start = start.min(s);
        end = end.max(e);
    }
    Ok((start, end))
}
fn words(tracks: &Value, range: (i64, i64)) -> Vec<(String, i64, i64)> {
    let source = all(tracks)
        .into_iter()
        .find(|t| t["captionSource"].is_object());
    source
        .into_iter()
        .flat_map(|t| arr(&t["captionSource"]["words"]))
        .filter_map(|w| {
            let (s, e) = word_times(w).ok()?;
            let mid = s + (e - s) / 2;
            (mid >= range.0 && mid < range.1).then(|| {
                (
                    w["text"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .filter(|c| c.is_alphanumeric())
                        .flat_map(char::to_lowercase)
                        .collect(),
                    s,
                    e,
                )
            })
        })
        .collect()
}
// Monotone word alignment preserves a deleted middle phrase even when the other
// performance has a different cadence. Bound work; unmatched wording interpolates.
fn anchors(old: &Value, new: &Value, ob: (i64, i64), nb: (i64, i64)) -> Vec<(i64, i64)> {
    let a = words(old, ob);
    let b = words(new, nb);
    let mut points = vec![(ob.0, nb.0)];
    if a.len().saturating_mul(b.len()) <= 1_000_000 {
        let width = b.len() + 1;
        let mut dp = vec![0u32; (a.len() + 1) * width];
        for i in (0..a.len()).rev() {
            for j in (0..b.len()).rev() {
                dp[i * width + j] = if !a[i].0.is_empty() && a[i].0 == b[j].0 {
                    1 + dp[(i + 1) * width + j + 1]
                } else {
                    dp[(i + 1) * width + j].max(dp[i * width + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < a.len() && j < b.len() {
            if !a[i].0.is_empty() && a[i].0 == b[j].0 {
                for p in [(a[i].1, b[j].1), (a[i].2, b[j].2)] {
                    let last = *points.last().unwrap();
                    if p.0 > last.0 && p.1 > last.1 && p.0 < ob.1 && p.1 < nb.1 {
                        points.push(p);
                    }
                }
                i += 1;
                j += 1;
            } else if dp[(i + 1) * width + j] >= dp[i * width + j + 1] {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    points.push((ob.1, nb.1));
    points
}
fn mapped(points: &[(i64, i64)], time: i64) -> i64 {
    let p = points
        .windows(2)
        .find(|p| time <= p[1].0)
        .unwrap_or(&points[points.len() - 2..]);
    p[0].1
        + (((time.clamp(p[0].0, p[1].0) - p[0].0) as f64 / (p[1].0 - p[0].0) as f64)
            * (p[1].1 - p[0].1) as f64)
            .round() as i64
}
fn timeline_time(edits: &[Edit], time: i64) -> i64 {
    let mut shift = 0;
    for e in edits {
        if time < e.from {
            break;
        }
        if time < e.to {
            return e.dest
                + (((time - e.from) as f64 / (e.to - e.from) as f64) * e.duration() as f64).round()
                    as i64;
        }
        shift += e.duration() - (e.to - e.from);
    }
    time + shift
}
pub(super) fn crop(
    e: &Value,
    from: i64,
    to: i64,
    dest: i64,
    fresh: &mut dyn FnMut() -> String,
) -> Result<Option<Value>, CapabilityError> {
    if from >= to {
        return Ok(None);
    }
    if e["type"] != "text" {
        return slice(e, from, to, dest, fresh).map(Some);
    }
    let start = tick(&e["startTime"])?;
    let entries = classic_text::timed_words(e)?
        .into_iter()
        .filter(|(_, s, end, _)| {
            let mid = start + s + (end - s) / 2;
            mid >= from && mid < to
        })
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return Ok(None);
    }
    let mut result = classic_text::build_part(e, entries, from - start, to - from, false, false);
    result["id"] = json!(fresh());
    result["startTime"] = json!(dest);
    // Slicing a timed cue also slices animation channels and transition bounds.
    let (_, right) = classic_keyframes::split_animations(&e["animations"], from - start, &fresh())?;
    let (animation, _) = classic_keyframes::split_animations(&right, to - from, &fresh())?;
    if animation.is_null() {
        result.as_object_mut().unwrap().remove("animations");
    } else {
        result["animations"] = animation;
    }
    classic_update::transitions(&mut result, e)?;
    if result["responsiveText"].is_object() {
        let content = result["params"]["content"].clone();
        result["responsiveText"]["sourceContent"] = content.clone();
        result["responsiveText"]["generatedContent"] = content;
    }
    Ok(Some(result))
}
fn retime_keys(v: &mut Value, factor: f64) {
    match v {
        Value::Object(o) => {
            for (key, v) in o {
                if matches!(key.as_str(), "time" | "dt") && v.is_number() {
                    *v = json!((v.as_f64().unwrap() * factor).round() as i64);
                } else {
                    retime_keys(v, factor);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|v| retime_keys(v, factor)),
        _ => {}
    }
}
fn preserve_style(
    next: &mut Value,
    current: &Value,
    from: i64,
    to: i64,
    fresh: &mut dyn FnMut() -> String,
) -> Result<(), CapabilityError> {
    // Audio source offsets belong to the new performance; all authored look/mix settings remain.
    let source_params = next["params"].clone();
    let content = next["params"]["content"].clone();
    next["params"] = current["params"].clone();
    for key in ["sourceAudioOffsetSeconds", "audioSyncOffset"] {
        if let Some(v) = source_params.get(key) {
            next["params"][key] = v.clone();
        } else {
            next["params"].as_object_mut().unwrap().remove(key);
        }
    }
    if next["type"] == "text" {
        next["params"]["content"] = content;
    }
    for (key, value) in current.as_object().unwrap() {
        if key.starts_with("caption")
            || matches!(
                key.as_str(),
                "hidden" | "isSourceAudioEnabled" | "effects" | "textRowOverrides"
            )
        {
            next[key] = value.clone();
        }
    }
    let start = tick(&current["startTime"])?;
    let (_, right) =
        classic_keyframes::split_animations(&current["animations"], from - start, &fresh())?;
    let (mut animation, _) = classic_keyframes::split_animations(&right, to - from, &fresh())?;
    if animation.is_null() {
        next.as_object_mut().unwrap().remove("animations");
    } else {
        retime_keys(
            &mut animation,
            tick(&next["duration"])? as f64 / (to - from) as f64,
        );
        next["animations"] = animation;
    }
    classic_update::transitions(next, current)?;
    Ok(())
}
fn source_matches(
    live: &Value,
    base: &Value,
    live_time: i64,
    base_time: i64,
) -> Result<bool, CapabilityError> {
    if live["mediaId"].is_null()
        || live["mediaId"] != base["mediaId"]
        || live["type"] != base["type"]
    {
        return Ok(false);
    }
    let source = |e: &Value, time: i64| -> Result<f64, CapabilityError> {
        Ok(tick(&e["trimStart"])? as f64
            + (time - tick(&e["startTime"])?) as f64 * classic_update::rate(e))
    };
    Ok((source(live, live_time)? - source(base, base_time)?).abs() <= 3.0)
}
fn replace_track(
    track: &Value,
    old: Option<&Value>,
    new: Option<&Value>,
    edits: &[Edit],
    main: bool,
    fresh: &mut dyn FnMut() -> String,
) -> Result<Value, CapabilityError> {
    let captions = track["captionSource"].is_object();
    let mut out = track.clone();
    let mut elements = Vec::new();
    for live in arr(&track["elements"]) {
        let (ls, le) = bounds(live)?;
        let relevant = edits
            .iter()
            .filter(|e| ls < e.to && le > e.from)
            .filter_map(|e| {
                let from = ls.max(e.from);
                let to = le.min(e.to);
                let base_time = e.old_from + ((from - e.from) as f64 * e.speed).round() as i64;
                let linked = if main {
                    live["id"] == e.element_id
                } else {
                    captions
                        || old.is_some_and(|t| {
                            arr(&t["elements"]).iter().any(|b| {
                                bounds(b).is_ok_and(|(s, end)| base_time >= s && base_time < end)
                                    && source_matches(live, b, from, base_time).unwrap_or(false)
                            })
                        })
                };
                linked.then_some((e, from, to))
            })
            .collect::<Vec<_>>();
        if relevant.is_empty() {
            let mut copy = live.clone();
            copy["startTime"] = json!(timeline_time(edits, ls));
            elements.push(copy);
            continue;
        }
        let mut cursor = ls;
        for (e, from, to) in relevant {
            if let Some(part) = crop(live, cursor, from, timeline_time(edits, cursor), fresh)? {
                elements.push(part);
            }
            // Caption generation is done once per edit below, rather than once per old cue.
            if !captions {
                let nf = e.new_from
                    + (((from - e.from) as f64 / (e.to - e.from) as f64)
                        * (e.new_to - e.new_from) as f64)
                        .round() as i64;
                let nt = e.new_from
                    + (((to - e.from) as f64 / (e.to - e.from) as f64)
                        * (e.new_to - e.new_from) as f64)
                        .round() as i64;
                for replacement in new.into_iter().flat_map(|t| arr(&t["elements"])) {
                    let (s, end) = bounds(replacement)?;
                    let a = s.max(nf);
                    let b = end.min(nt);
                    if let Some(mut piece) = crop(replacement, a, b, e.new_time(a), fresh)? {
                        piece["duration"] = json!((e.new_time(b) - e.new_time(a)).max(1));
                        if (e.speed - 1.0).abs() > 1e-8 {
                            let rate = classic_update::rate(replacement) * e.speed;
                            piece["retime"] = json!({"rate":rate});
                        }
                        let cf = from
                            + (((a - nf) as f64 / (nt - nf).max(1) as f64) * (to - from) as f64)
                                .round() as i64;
                        let ct = from
                            + (((b - nf) as f64 / (nt - nf).max(1) as f64) * (to - from) as f64)
                                .round() as i64;
                        preserve_style(&mut piece, live, cf, ct.max(cf + 1), fresh)?;
                        elements.push(piece);
                    }
                }
            }
            cursor = to;
        }
        if let Some(part) = crop(live, cursor, le, timeline_time(edits, cursor), fresh)? {
            elements.push(part);
        }
    }
    if captions {
        for e in edits {
            let styles = arr(&track["elements"])
                .iter()
                .filter(|c| bounds(c).is_ok_and(|(s, end)| s < e.to && end > e.from))
                .collect::<Vec<_>>();
            if styles.is_empty() {
                continue;
            } // Never restore an intentionally removed caption layer.
            for cue in new.into_iter().flat_map(|t| arr(&t["elements"])) {
                let (s, end) = bounds(cue)?;
                let a = s.max(e.new_from);
                let b = end.min(e.new_to);
                if let Some(mut piece) = crop(cue, a, b, e.new_time(a), fresh)? {
                    let old_time = e.from
                        + (((a - e.new_from) as f64 / (e.new_to - e.new_from) as f64)
                            * (e.to - e.from) as f64)
                            .round() as i64;
                    let style = styles
                        .iter()
                        .min_by_key(|c| (tick(&c["startTime"]).unwrap_or(0) - old_time).abs())
                        .unwrap();
                    let (ss, se) = bounds(style)?;
                    piece["duration"] = json!((e.new_time(b) - e.new_time(a)).max(1));
                    for run in piece["wordRuns"].as_array_mut().into_iter().flatten() {
                        for key in ["startTime", "endTime"] {
                            run[key] = json!((tick(&run[key])? as f64 / e.speed).round() as i64);
                        }
                    }
                    preserve_style(&mut piece, style, ss, se, fresh)?;
                    elements.push(piece);
                }
            }
        }
        let mut words = Vec::new();
        for word in arr(&track["captionSource"]["words"]) {
            let (s, end) = word_times(word)?;
            let mid = s + (end - s) / 2;
            if edits.iter().any(|e| mid >= e.from && mid < e.to) {
                continue;
            }
            let mut w = word.clone();
            w["start"] = json!(timeline_time(edits, s) as f64 / TPS);
            w["end"] = json!(timeline_time(edits, end) as f64 / TPS);
            words.push(w);
        }
        for e in edits {
            for word in new
                .into_iter()
                .flat_map(|t| arr(&t["captionSource"]["words"]))
            {
                let (s, end) = word_times(word)?;
                let mid = s + (end - s) / 2;
                if mid < e.new_from || mid >= e.new_to {
                    continue;
                }
                let mut w = word.clone();
                w["start"] = json!(e.new_time(s.max(e.new_from)) as f64 / TPS);
                w["end"] = json!(e.new_time(end.min(e.new_to)) as f64 / TPS);
                words.push(w);
            }
        }
        words.sort_by(|a, b| {
            a["start"]
                .as_f64()
                .partial_cmp(&b["start"].as_f64())
                .unwrap()
        });
        out["captionSource"]["words"] = json!(words);
    }
    elements.sort_by_key(|e| e["startTime"].as_i64().unwrap_or(0));
    out["elements"] = json!(elements);
    Ok(out)
}

pub(super) fn apply(
    a: &Assembly,
    groups: &[usize],
    scene: &Value,
    replacement: &Value,
    canvas: &Value,
    fresh: &mut dyn FnMut() -> String,
    context: &InvocationContext,
) -> Result<(Value, Value), CapabilityError> {
    let (words, start, end) = assembly_inventory(a)?;
    let mut comparison = 0;
    let (old, _) = render(
        a,
        &words,
        start,
        end,
        canvas,
        &mut || {
            comparison += 1;
            format!("baseline-{comparison}")
        },
        context,
    )?;
    let mut current = scene.clone();
    for &group in groups {
        if context.cancellation.is_cancelled() {
            return Err(CapabilityError::Failed("Take replacement cancelled".into()));
        }
        let (tracks, bookmarks) = apply_group(a, group, &current, replacement, &old, fresh)?;
        current["tracks"] = tracks;
        current["bookmarks"] = bookmarks;
    }
    Ok((current["tracks"].take(), current["bookmarks"].take()))
}
fn apply_group(
    a: &Assembly,
    group: usize,
    scene: &Value,
    replacement: &Value,
    old: &Value,
    fresh: &mut dyn FnMut() -> String,
) -> Result<(Value, Value), CapabilityError> {
    let ob = group_bounds(old, a, group)?;
    let nb = group_bounds(replacement, a, group)?;
    let mapping = anchors(old, replacement, ob, nb);
    let mut edits = Vec::new();
    for live in arr(&scene["tracks"]["main"]["elements"])
        .iter()
        .filter(|e| belongs(e, a, group))
    {
        let (ls, le) = bounds(live)?;
        let trim = tick(&live["trimStart"])? as f64;
        let mut matched = false;
        for base in arr(&old["main"]["elements"])
            .iter()
            .filter(|e| belongs(e, a, group) && e["mediaId"] == live["mediaId"])
        {
            let (bs, be) = bounds(base)?;
            let rate = classic_update::rate(base);
            let source_start = tick(&base["trimStart"])? as f64;
            let os = bs + ((trim - source_start) / rate).round() as i64;
            let oe = os + (((le - ls) as f64 * classic_update::rate(live)) / rate).round() as i64;
            if os < bs - 3 || oe > be + 3 {
                continue;
            }
            let nf = mapped(&mapping, os.max(bs));
            let nt = mapped(&mapping, oe.min(be));
            if nt <= nf {
                return Err(invalid(
                    "The retained take range is empty in this alternative",
                ));
            }
            edits.push(Edit {
                element_id: live["id"].as_str().unwrap_or("").to_owned(),
                from: ls,
                to: le,
                old_from: os,
                new_from: nf,
                new_to: nt,
                dest: ls,
                speed: classic_update::rate(live) / rate,
            });
            matched = true;
            break;
        }
        if !matched {
            return Err(CapabilityError::Conflict("This take's source was replaced or extended beyond its archived range. Restore its source before choosing an alternative; edits to other clips are preserved.".into()));
        }
    }
    if edits.is_empty() {
        return Err(invalid(
            "This take was deleted. Select a surviving take to replace",
        ));
    }
    edits.sort_by_key(|e| e.from);
    if edits.windows(2).any(|p| p[0].to > p[1].from) {
        return Err(invalid(
            "Overlapping occurrences of the same take cannot be replaced",
        ));
    }
    let mut shift = 0;
    for e in &mut edits {
        e.dest += shift;
        shift += e.duration() - (e.to - e.from);
    }
    let mut tracks = scene["tracks"].clone();
    tracks["main"] = replace_track(
        &tracks["main"],
        Some(&old["main"]),
        Some(&replacement["main"]),
        &edits,
        true,
        fresh,
    )?;
    for kind in ["overlay", "audio"] {
        for track in tracks[kind].as_array_mut().into_iter().flatten() {
            let find = |collection: &Value| {
                arr(&collection[kind])
                    .iter()
                    .find(|t| t["id"] == track["id"])
                    .cloned()
            };
            let before = find(old);
            let after = find(replacement);
            *track = replace_track(track, before.as_ref(), after.as_ref(), &edits, false, fresh)?;
        }
    }
    let mut bookmarks = scene["bookmarks"].clone();
    for b in bookmarks.as_array_mut().into_iter().flatten() {
        b["time"] = json!(timeline_time(&edits, tick(&b["time"])?));
    }
    Ok((tracks, bookmarks))
}
