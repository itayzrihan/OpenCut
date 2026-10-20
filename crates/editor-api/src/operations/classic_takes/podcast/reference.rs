//! Timeline-time reference scope. Camera cuts never become transcript boundaries.
use super::super::quality::AudioFrame;
use super::*;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Region {
    pub id: String,
    pub start: i64,
    pub end: i64,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AudioInput {
    pub reference_id: String,
    pub clip: Value,
}
fn av(e: &Value) -> bool {
    matches!(e["type"].as_str(), Some("video" | "audio"))
}
fn merged_ranges(mut spans: Vec<(i64, i64)>) -> Vec<(i64, i64)> {
    spans.sort_unstable();
    let mut out: Vec<(i64, i64)> = vec![];
    for (a, b) in spans {
        if a >= b {
            continue;
        }
        if let Some(last) = out.last_mut() {
            if a <= last.1 {
                last.1 = last.1.max(b);
                continue;
            }
        }
        out.push((a, b));
    }
    out
}
pub(crate) fn regions(tracks: &Value, ids: &[String]) -> Result<Vec<Region>, CapabilityError> {
    let unique: HashSet<&str> = ids.iter().map(String::as_str).collect();
    if ids.len() > 100000 || unique.len() != ids.len() {
        return Err(invalid("Choose at most100000 distinct timeline clips"));
    }
    let elements: Vec<_> = all(tracks).flat_map(|t| arr(&t["elements"])).collect();
    let known: HashSet<_> = elements.iter().filter_map(|e| e["id"].as_str()).collect();
    if unique.iter().any(|id| !known.contains(id)) {
        return Err(invalid("Selected timeline clip no longer exists"));
    }
    let times = |e: &&Value| -> Result<(i64, i64), CapabilityError> {
        let a = tick(&e["startTime"])?;
        Ok((a, a + tick(&e["duration"])?))
    };
    let media = merged_ranges(
        elements
            .iter()
            .filter(|e| av(e))
            .map(times)
            .collect::<Result<Vec<_>, _>>()?,
    );
    let selected: Vec<_> = elements
        .iter()
        .filter(|e| unique.contains(e["id"].as_str().unwrap_or("")))
        .copied()
        .collect();
    let has_av = selected.iter().any(|e| av(e));
    let ranges = if ids.is_empty() {
        media
    } else {
        let chosen = merged_ranges(
            selected
                .iter()
                .filter(|e| !has_av || av(e))
                .map(times)
                .collect::<Result<Vec<_>, _>>()?,
        );
        let (mut i, mut j) = (0, 0);
        let mut intersections = vec![];
        while i < media.len() && j < chosen.len() {
            let a = media[i].0.max(chosen[j].0);
            let b = media[i].1.min(chosen[j].1);
            if a < b {
                intersections.push((a, b));
            }
            if media[i].1 <= chosen[j].1 {
                i += 1;
            } else {
                j += 1;
            }
        }
        merged_ranges(intersections)
    };
    if ranges.is_empty() {
        return Err(invalid(
            "The reference needs timeline video or audio inside the selection",
        ));
    }
    let av_known: HashSet<_> = elements
        .iter()
        .filter(|e| av(e))
        .filter_map(|e| e["id"].as_str())
        .collect();
    let physical: HashMap<_, _> = arr(&tracks["main"]["elements"])
        .iter()
        .filter(|e| av(e))
        .filter_map(|e| {
            Some((
                (
                    e["startTime"].as_i64()?,
                    e["startTime"].as_i64()? + e["duration"].as_i64()?,
                ),
                e["id"].as_str()?.to_owned(),
            ))
        })
        .collect();
    Ok(ranges
        .into_iter()
        .map(|(start, end)| Region {
            id: physical.get(&(start, end)).cloned().unwrap_or_else(|| {
                let base = format!("podcast-reference:{start}:{end}");
                let mut id = base.clone();
                let mut suffix = 0;
                while av_known.contains(id.as_str()) {
                    suffix += 1;
                    id = format!("{base}:{suffix}");
                }
                id
            }),
            start,
            end,
        })
        .collect())
}
pub(super) fn anchor_ids(tracks: &Value, ids: &[String]) -> Vec<String> {
    let selected: HashSet<_> = ids.iter().map(String::as_str).collect();
    let av_ids = all(tracks)
        .flat_map(|t| arr(&t["elements"]))
        .filter(|e| av(e) && selected.contains(e["id"].as_str().unwrap_or("")))
        .filter_map(|e| e["id"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    if av_ids.is_empty() {
        ids.to_vec()
    } else {
        av_ids
    }
}
pub(crate) fn encoded_bounds(id: &str) -> Option<(i64, i64)> {
    let mut parts = id.strip_prefix("podcast-reference:")?.split(':');
    let a = parts.next()?.parse().ok()?;
    let b = parts.next()?.parse().ok()?;
    (a >= 0 && b > a && b <= crate::classic::MAX_SAFE_INTEGER).then_some((a, b))
}
pub(in crate::operations::classic_takes) fn evidence(
    tracks: &Value,
) -> Result<Vec<Value>, CapabilityError> {
    let ids = all(tracks)
        .flat_map(|t| arr(&t["elements"]))
        .filter(|e| av(e))
        .filter_map(|e| e["id"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let mut normalized = tracks.clone();
    let mut seen = HashSet::new();
    let mut words = vec![];
    for t in all(tracks).filter(|t| t["captionSource"].is_object()) {
        for w in arr(&t["captionSource"]["words"]) {
            let (a, b) = word_times(w)?;
            let key = (a, b, w["text"].as_str().unwrap_or("").to_owned());
            if seen.insert(key) {
                words.push(w.clone());
            }
        }
    }
    words.sort_by_key(|w| word_times(w).map(|(a, b)| (a, b)).unwrap_or_default());
    for t in normalized["overlay"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .filter(|t| t["captionSource"].is_object())
    {
        t["captionSource"]["sourceId"] = json!("podcast-reference");
        t["captionSource"]["words"] = json!(words);
    }
    quality::source_words(&normalized, &ids, true)
}
pub(in crate::operations::classic_takes) fn inventory(
    tracks: &Value,
    regions: &[Region],
) -> Result<(Vec<Word>, i64, i64), CapabilityError> {
    let mut words = vec![];
    for (source_index, w) in evidence(tracks)?.iter().enumerate() {
        if w["source"]["type"] == "text-layer" {
            continue;
        }
        let (start, end) = word_times(w)?;
        // Selection is a hard boundary: never expose even part of an excluded word.
        if let Some(r) = regions
            .get(regions.partition_point(|r| r.end <= start))
            .filter(|r| start >= r.start && end <= r.end)
        {
            words.push(Word {
                id: 0,
                source_index,
                clip_id: r.id.clone(),
                text: w["text"].as_str().unwrap_or("").into(),
                start,
                end,
            });
        }
    }
    words.sort_by_key(|w| (w.start, w.end));
    for (id, w) in words.iter_mut().enumerate() {
        w.id = id;
    }
    if words.is_empty() || words.len() > 60000 {
        return Err(invalid(
            "The reference needs1..60000 transcribed words inside the selected timeline ranges",
        ));
    }
    Ok((words, regions[0].start, regions.last().unwrap().end))
}
pub(super) fn audio_inputs(
    tracks: &Value,
    regions: &[Region],
) -> Result<Vec<AudioInput>, CapabilityError> {
    let mut out = vec![];
    let known: HashSet<_> = all(tracks)
        .flat_map(|t| arr(&t["elements"]))
        .filter(|e| av(e))
        .filter_map(|e| e["id"].as_str())
        .chain(regions.iter().map(|r| r.id.as_str()))
        .collect();
    for (ti, t) in all(tracks).enumerate().filter(|(_, t)| t["muted"] != true) {
        for (ei, e) in arr(&t["elements"])
            .iter()
            .enumerate()
            .filter(|(_, e)| av(e))
        {
            // Volume is measured in dB: zero is unity, not silence.
            if e["enabled"] == false
                || e["params"]["muted"] == true
                || e["muted"] == true
                || e["isSourceAudioEnabled"] == false
            {
                continue;
            }
            let rate = classic_update::rate(e);
            let timing = classic_timeline::resolve_clip_audio_timing(
                classic_timeline::ClipAudioTimingOptions {
                    start_time: tick(&e["startTime"])? as f64 / TPS,
                    duration: tick(&e["duration"])? as f64 / TPS,
                    trim_start: tick(&e["trimStart"])? as f64 / TPS,
                    rate,
                    offset_seconds: e["params"]["audioSyncOffset"].as_f64().unwrap_or(0.0),
                    source_offset_seconds: e["params"]["sourceAudioOffsetSeconds"].as_f64(),
                },
            );
            let from = (timing.start_time * TPS).round() as i64;
            let to = ((timing.start_time + timing.duration) * TPS).round() as i64;
            let first = regions.partition_point(|r| r.end <= from);
            for (ri, r) in regions
                .iter()
                .enumerate()
                .skip(first)
                .take_while(|(_, r)| r.start < to)
            {
                let start = r.start.max(from);
                let end = r.end.min(to);
                if start >= end {
                    continue;
                }
                let base = format!("podcast-audio:{ri}:{ti}:{ei}");
                let mut id = base.clone();
                let mut suffix = 0;
                while known.contains(id.as_str()) {
                    suffix += 1;
                    id = format!("{base}:{suffix}");
                }
                let mut clip = e.clone();
                clip["id"] = json!(id);
                clip["startTime"] = json!(start);
                clip["duration"] = json!(end - start);
                clip["trimStart"] = json!(
                    ((timing.trim_start + (start as f64 / TPS - timing.start_time) * rate) * TPS)
                        .round() as i64
                );
                clip["trimEnd"] = json!(0);
                clip["params"]["audioSyncOffset"] = json!(0);
                clip["params"]["sourceAudioOffsetSeconds"] = json!(0);
                clip["retime"] = json!({"rate":rate});
                out.push(AudioInput {
                    reference_id: r.id.clone(),
                    clip,
                });
                if out.len() > 20000 {
                    return Err(invalid("Too many podcast source audio windows"));
                }
            }
        }
    }
    Ok(out)
}
pub(super) fn audio_evidence(
    tracks: &Value,
    regions: &[Region],
    input: Vec<AudioEvidence>,
) -> Result<Vec<AudioEvidence>, CapabilityError> {
    let sources = audio_inputs(tracks, regions)?;
    if input.iter().map(|e| e.frames.len()).sum::<usize>() > 360000 {
        return Err(invalid("Podcast audio evidence exceeds bounded budget"));
    }
    let mut seen = HashSet::new();
    for e in &input {
        if !seen.insert(&e.clip_id) || !sources.iter().any(|s| s.clip["id"] == e.clip_id) {
            return Err(invalid("Audio evidence is outside the selected reference"));
        }
    }
    // Per-bin complete coverage across every active audio route; unknown decode
    // samples never become false silence. Conservative max protects either mic.
    let total: i64 = regions.iter().map(|r| r.end - r.start).sum();
    let step = 1200.max((total + 169999) / 170000);
    let mut result = vec![];
    for r in regions {
        let count = ((r.end - r.start + step - 1) / step) as usize;
        let mut expected = vec![0i64; count];
        let mut known = vec![0i64; count];
        let mut rms = vec![0f64; count];
        let mut peak = vec![0f64; count];
        let mut zcr = vec![0f64; count];
        for s in sources.iter().filter(|s| s.reference_id == r.id) {
            let start = tick(&s.clip["startTime"])?;
            let end = start + tick(&s.clip["duration"])?;
            for i in ((start - r.start) / step) as usize..=((end - r.start - 1) / step) as usize {
                let a = (r.start + i as i64 * step).max(start);
                let b = (r.start + (i as i64 + 1) * step).min(end).min(r.end);
                expected[i] += b - a;
            }
            let Some(e) = input.iter().find(|e| s.clip["id"] == e.clip_id) else {
                continue;
            };
            let mut previous = 0f64;
            let mut previous_tick = start;
            for (frame_index, f) in e.frames.iter().enumerate() {
                if ![f.start, f.end, f.rms, f.peak, f.zero_crossing_rate]
                    .iter()
                    .all(|v| v.is_finite())
                    || f.start + 0.000001 < previous
                    || f.end <= f.start
                    || f.start < 0.0
                    || f.rms < 0.0
                    || f.peak < 0.0
                    || f.zero_crossing_rate < 0.0
                    || f.end > (end - start) as f64 / TPS + 0.001
                {
                    return Err(invalid(format!(
                        "Invalid podcast decoded audio frame: clip={}, frame={}, start={}, end={}, previousEnd={}, duration={}, rms={}, peak={}, zcr={}",
                        e.clip_id,
                        frame_index,
                        f.start,
                        f.end,
                        previous,
                        (end - start) as f64 / TPS,
                        f.rms,
                        f.peak,
                        f.zero_crossing_rate
                    )));
                }
                previous = f.end;
                let a = (start + (f.start * TPS).round() as i64)
                    .max(start)
                    .max(previous_tick);
                let b = (start + (f.end * TPS).round() as i64).min(end);
                previous_tick = previous_tick.max(b);
                if a >= b {
                    continue;
                }
                for i in ((a - r.start) / step) as usize..=((b - r.start - 1) / step) as usize {
                    let from = (r.start + i as i64 * step).max(a);
                    let to = (r.start + (i as i64 + 1) * step).min(b).min(r.end);
                    known[i] += to - from;
                    rms[i] = rms[i].max(f.rms);
                    peak[i] = peak[i].max(f.peak);
                    zcr[i] = zcr[i].max(f.zero_crossing_rate);
                }
            }
        }
        let frames = (0..count)
            .filter(|&i| expected[i] > 0 && known[i] >= expected[i])
            .map(|i| AudioFrame {
                start: i as f64 * step as f64 / TPS,
                end: ((i as i64 + 1) * step).min(r.end - r.start) as f64 / TPS,
                rms: rms[i],
                peak: peak[i],
                zero_crossing_rate: zcr[i],
            })
            .collect();
        result.push(AudioEvidence {
            clip_id: r.id.clone(),
            frames,
        });
    }
    Ok(result)
}

pub(in crate::operations::classic_takes) fn mask_tracks(
    tracks: &Value,
    regions: &[Region],
) -> Result<Value, CapabilityError> {
    let mut scoped = tracks.clone();
    let mut counter = 0;
    let mut map = |t: &mut Value| -> Result<(), CapabilityError> {
        let mut clips = vec![];
        for e in arr(&t["elements"]) {
            if !av(e) {
                continue;
            }
            let start = tick(&e["startTime"])?;
            let end = start + tick(&e["duration"])?;
            for r in regions
                .iter()
                .skip(regions.partition_point(|r| r.end <= start))
                .take_while(|r| r.start < end)
            {
                let a = start.max(r.start);
                let b = end.min(r.end);
                if a < b {
                    let mut fresh = || {
                        counter += 1;
                        format!("podcast-transcription:{counter}")
                    };
                    clips.push(slice(e, a, b, a, &mut fresh)?);
                }
            }
        }
        t["elements"] = json!(clips);
        t.as_object_mut().unwrap().remove("captionSource");
        Ok(())
    };
    map(&mut scoped["main"])?;
    for key in ["overlay", "audio"] {
        for t in scoped[key].as_array_mut().into_iter().flatten() {
            map(t)?;
        }
    }
    Ok(scoped)
}
