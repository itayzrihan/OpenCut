//! Classic-only take quality policy. Hosts supply decoded features, never edit decisions.
use super::*;

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AudioFrame {
    start: f64,
    end: f64,
    rms: f64,
    peak: f64,
    zero_crossing_rate: f64,
}
#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AudioEvidence {
    clip_id: String,
    #[schemars(length(max = 360000))]
    frames: Vec<AudioFrame>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AudioGaps {
    clip_id: String,
    ranges: Vec<(i64, i64)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    diagnostics: Option<AudioDiagnostics>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AudioDiagnostics {
    clip_id: String,
    frames_analyzed: usize,
    covered_start: Option<f64>,
    covered_end: Option<f64>,
    duration: f64,
    quiet_ranges: usize,
    safety_hold_reason: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct QualityReport {
    pub short_parts: usize,
    pub repeated_phrases: usize,
    pub unverified_boundaries: usize,
    #[serde(default)]
    pub audio_diagnostics: Vec<AudioDiagnostics>,
}
fn normalized(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Caption word runs contain the editor's timing/text corrections. Reuse them
/// only when they describe the complete visible cue and have valid local clocks.
/// Uncovered transcript words and all source metadata remain available.
pub(super) fn source_words(
    tracks: &Value,
    ids: &[String],
    precise: bool,
) -> Result<Vec<Value>, CapabilityError> {
    let original = arr(&source(tracks)?["words"]);
    if !precise {
        return Ok(original.to_vec());
    }
    let mut by_text: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, w) in original.iter().enumerate() {
        by_text
            .entry(normalized(w["text"].as_str().unwrap_or("")))
            .or_default()
            .push(i);
    }
    let mut replacements = vec![];
    let mut covered = vec![];
    let mut matched = HashSet::new();
    for clip in arr(&tracks["overlay"])
        .iter()
        .filter(|t| t["captionSource"].is_object())
        .flat_map(|t| arr(&t["elements"]))
    {
        let runs = arr(&clip["wordRuns"]);
        if runs.is_empty() || clip["type"] != "text" {
            continue;
        }
        let run_text = runs
            .iter()
            .filter_map(|r| r["text"].as_str())
            .collect::<Vec<_>>()
            .join(" ");
        if normalized(&run_text) != normalized(clip["params"]["content"].as_str().unwrap_or("")) {
            continue;
        }
        let start = tick(&clip["startTime"])?;
        let duration = tick(&clip["duration"])?;
        if !arr(&tracks["main"]["elements"]).iter().any(|c| {
            ids.iter().any(|id| c["id"] == *id)
                && c["startTime"].as_i64().is_some_and(|s| {
                    start >= s && start + duration <= s + c["duration"].as_i64().unwrap_or(0)
                })
        }) {
            continue;
        }
        // Trimmed/manual clocks cannot be safely inferred here.
        if clip["trimStart"].as_i64().unwrap_or(0) != 0 {
            continue;
        }
        let mut timed = vec![];
        for run in runs {
            let (Ok(s), Ok(e)) = (tick(&run["startTime"]), tick(&run["endTime"])) else {
                break;
            };
            let Some(text) = run["text"].as_str().filter(|s| !s.trim().is_empty()) else {
                break;
            };
            if text.split_whitespace().count() != 1
                || s >= e
                || e > duration
                || timed
                    .last()
                    .is_some_and(|(_, prev, _): &(String, i64, i64)| *prev > start + s)
            {
                break;
            }
            timed.push((text.to_owned(), start + s, start + e));
        }
        if timed.len() != runs.len() {
            continue;
        }
        let from = timed.iter().map(|(_, s, _)| *s).min().unwrap();
        let to = timed.iter().map(|(_, _, e)| *e).max().unwrap();
        // Overlapping authored cues are ambiguous: do not erase either source.
        if covered.iter().any(|(s, e)| from < *e && to > *s) {
            continue;
        }
        covered.push((from, to));
        for (text, s, e) in timed {
            let found = by_text
                .get(&normalized(&text))
                .into_iter()
                .flatten()
                .filter(|i| !matched.contains(*i))
                .filter_map(|i| {
                    seconds(&original[*i]["start"])
                        .ok()
                        .map(|t| (*i, (t - s).abs()))
                })
                .filter(|(_, d)| *d <= 120000)
                .min_by_key(|(_, d)| *d);
            let mut word = if let Some((i, _)) = found {
                matched.insert(i);
                original[i].clone()
            } else {
                json!({"text":text})
            };
            word["start"] = json!(s as f64 / TPS);
            word["end"] = json!(e as f64 / TPS);
            replacements.push(word);
        }
    }
    for (i, word) in original.iter().enumerate() {
        let (s, e) = word_times(word)?;
        let mid = s + (e - s) / 2;
        if !matched.contains(&i) && !covered.iter().any(|(from, to)| mid >= *from && mid < *to) {
            replacements.push(word.clone());
        }
    }
    replacements.sort_by_key(|w| seconds(&w["start"]).unwrap_or(0));
    Ok(replacements)
}

pub(super) fn analyze_audio(
    tracks: &Value,
    ids: &[String],
    evidence: Vec<AudioEvidence>,
) -> Result<Vec<AudioGaps>, CapabilityError> {
    if evidence.len() > ids.len() || evidence.iter().map(|e| e.frames.len()).sum::<usize>() > 360000
    {
        return Err(invalid(
            "Take audio evidence exceeds its bounded frame budget",
        ));
    }
    let words = source_words(tracks, ids, true)?;
    let mut seen = HashSet::new();
    let mut result = vec![];
    for e in evidence {
        if !ids.contains(&e.clip_id) || !seen.insert(e.clip_id.clone()) {
            return Err(invalid(
                "Audio evidence must identify distinct selected clips",
            ));
        }
        let clip = arr(&tracks["main"]["elements"])
            .iter()
            .find(|c| c["id"] == e.clip_id)
            .ok_or_else(|| invalid("Audio evidence clip missing"))?;
        let start = tick(&clip["startTime"])? as f64 / TPS;
        let duration = tick(&clip["duration"])? as f64 / TPS;
        let covered_start = e.frames.first().map(|f| f.start);
        let covered_end = e.frames.last().map(|f| f.end);
        let analysis = classic_timeline::analyze_smart_audio_silence(
            classic_timeline::AnalyzeSmartAudioSilenceOptions {
                frames: e
                    .frames
                    .into_iter()
                    .map(|f| classic_timeline::AudioAnalysisFrame {
                        start: f.start,
                        end: f.end,
                        rms: f.rms,
                        peak: f.peak,
                        zero_crossing_rate: f.zero_crossing_rate,
                    })
                    .collect(),
                duration_seconds: duration,
                transcript_words: words
                    .iter()
                    .enumerate()
                    .filter_map(|(i, w)| {
                        let s = w["start"].as_f64()?;
                        let end = w["end"].as_f64()?;
                        (end > start && s < start + duration).then_some(
                            classic_timeline::TranscriptWordTiming {
                                word_index: i,
                                start: (s - start).max(0.0),
                                end: (end - start)
                                    .min(duration)
                                    .max((s - start).max(0.0) + 0.001),
                            },
                        )
                    })
                    .collect(),
                settings: classic_timeline::SmartAudioSilenceSettings {
                    min_silence_seconds: 0.04,
                    speech_padding_seconds: 0.06,
                    bridge_gap_seconds: 0.04,
                },
            },
        );
        result.push(AudioGaps {
            diagnostics: Some(AudioDiagnostics {
                clip_id: e.clip_id.clone(),
                frames_analyzed: analysis.diagnostics.frames_analyzed,
                covered_start,
                covered_end,
                duration,
                quiet_ranges: analysis.cut_ranges.len(),
                safety_hold_reason: analysis.diagnostics.safety_hold_reason,
            }),
            clip_id: e.clip_id,
            ranges: analysis
                .cut_ranges
                .iter()
                .map(|r| {
                    (
                        ((start + r.start) * TPS).round() as i64,
                        ((start + r.end) * TPS).round() as i64,
                    )
                })
                .collect(),
        });
    }
    Ok(result)
}

pub(super) fn merged(parts: &[Part], words: &[Word]) -> Vec<Part> {
    let mut result: Vec<Part> = vec![];
    for p in parts {
        if let Some(last) = result.last_mut() {
            if last.last_word + 1 == p.first_word
                && words[last.first_word].clip_id == words[p.first_word].clip_id
            {
                last.last_word = p.last_word;
                continue;
            }
        }
        result.push(p.clone());
    }
    result
}
pub(super) fn repeats(alt: &Alternative, words: &[Word]) -> usize {
    let tokens: Vec<_> = alt
        .parts
        .iter()
        .flat_map(|p| p.first_word..=p.last_word)
        .map(|i| normalized(&words[i].text))
        .collect();
    // Penalize repeated phrases, not a single emphatic word. This is a ranking
    // signal, never permission to delete wording or invent a replacement.
    (0..tokens.len())
        .filter(|i| {
            (2..=6)
                .any(|n| i + 2 * n <= tokens.len() && tokens[*i..i + n] == tokens[i + n..i + 2 * n])
        })
        .count()
}
pub(super) fn short(alt: &Alternative, words: &[Word]) -> usize {
    if alt.parts.len() < 2 {
        return 0;
    }
    alt.parts
        .iter()
        .filter(|p| {
            p.last_word - p.first_word + 1 < 4
                || words[p.last_word].end - words[p.first_word].start < 120000
        })
        .count()
}
pub(super) fn prefer_coherent(
    plan: &mut Plan,
    words: &[Word],
    tracks: &Value,
    gaps: &[AudioGaps],
) -> Result<(), CapabilityError> {
    for group in &mut plan.groups {
        let original = group.selected;
        group.selected = group
            .alternatives
            .iter()
            .enumerate()
            .min_by_key(|(i, alt)| {
                let a = Alternative {
                    parts: merged(&alt.parts, words),
                    ..(*alt).clone()
                };
                repeats(&a, words) * 40
                    + short(&a, words) * 12
                    + a.parts.len().saturating_sub(1) * 3
                    + report(
                        &Plan {
                            groups: vec![Group {
                                alternatives: vec![a.clone()],
                                selected: 0,
                                ..group.clone()
                            }],
                            discarded: vec![],
                        },
                        words,
                        tracks,
                        gaps,
                    )
                    .map(|r| r.unverified_boundaries * 2)
                    .unwrap_or(usize::MAX / 2)
                    + usize::from(*i != original)
            })
            .unwrap()
            .0;
    }
    Ok(())
}
pub(super) fn report(
    plan: &Plan,
    words: &[Word],
    tracks: &Value,
    gaps: &[AudioGaps],
) -> Result<QualityReport, CapabilityError> {
    let mut q = QualityReport {
        audio_diagnostics: gaps.iter().filter_map(|g| g.diagnostics.clone()).collect(),
        ..QualityReport::default()
    };
    for g in &plan.groups {
        let a = Alternative {
            parts: merged(&g.alternatives[g.selected].parts, words),
            ..g.alternatives[g.selected].clone()
        };
        q.short_parts += short(&a, words);
        q.repeated_phrases += repeats(&a, words);
        for p in &a.parts {
            let (from, to) = bounds(p, words, tracks, gaps)?;
            let clip = arr(&tracks["main"]["elements"])
                .iter()
                .find(|c| c["id"] == words[p.first_word].clip_id)
                .unwrap();
            let start = tick(&clip["startTime"])?;
            let end = start + tick(&clip["duration"])?;
            let quiet = gaps
                .iter()
                .find(|g| g.clip_id == words[p.first_word].clip_id);
            for boundary in [from, to] {
                if boundary != start
                    && boundary != end
                    && !quiet.is_some_and(|g| {
                        g.ranges
                            .iter()
                            .any(|(s, e)| boundary >= *s && boundary <= *e)
                    })
                {
                    q.unverified_boundaries += 1;
                }
            }
        }
    }
    Ok(q)
}
/// Expand outwards; never narrow a selected word. Neighbouring omitted speech
/// limits handles. Snap to verified quiet regions when available, otherwise
/// retain bounded handles and explicitly report that the boundary is unverified.
pub(super) fn bounds(
    p: &Part,
    words: &[Word],
    tracks: &Value,
    gaps: &[AudioGaps],
) -> Result<(i64, i64), CapabilityError> {
    let first = &words[p.first_word];
    let end = words[p.first_word..=p.last_word]
        .iter()
        .map(|w| w.end)
        .max()
        .unwrap();
    let clip = arr(&tracks["main"]["elements"])
        .iter()
        .find(|e| e["id"] == first.clip_id)
        .ok_or_else(|| invalid("Take source clip missing"))?;
    let clip_start = tick(&clip["startTime"])?;
    let clip_end = clip_start + tick(&clip["duration"])?;
    let before = words
        .iter()
        .take(p.first_word)
        .filter(|w| w.clip_id == first.clip_id)
        .map(|w| w.end)
        .max()
        .unwrap_or(clip_start)
        .min(first.start);
    let after = words
        .iter()
        .skip(p.last_word + 1)
        .filter(|w| w.clip_id == first.clip_id)
        .map(|w| w.start)
        .min()
        .unwrap_or(clip_end)
        .max(end);
    let low = before.max(first.start - 60000);
    let high = after.min(end + 60000);
    let ranges = gaps
        .iter()
        .find(|g| g.clip_id == first.clip_id)
        .map(|g| g.ranges.as_slice())
        .unwrap_or(&[]);
    let quiet_before = ranges
        .iter()
        .filter_map(|(s, e)| {
            let s = (*s).max(low);
            let e = (*e).min(first.start);
            (e - s >= 1200).then_some((s + e) / 2)
        })
        .max();
    let quiet_after = ranges
        .iter()
        .filter_map(|(s, e)| {
            let s = (*s).max(end);
            let e = (*e).min(high);
            (e - s >= 1200).then_some((s + e) / 2)
        })
        .min();
    let from = quiet_before
        .unwrap_or(first.start - (first.start - before).min(19200) / 2)
        .max(clip_start);
    let to = quiet_after
        .unwrap_or(end + (after - end).min(28800) / 2)
        .min(clip_end);
    Ok((from, to))
}

pub(super) fn remap_caption_presentation(
    tracks: &mut Value,
    spans: &[Span],
    fresh: &mut dyn FnMut() -> String,
) -> Result<Vec<Value>, CapabilityError> {
    let mut ignored = vec![];
    for track in tracks["overlay"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .filter(|t| t["captionSource"].is_object())
    {
        let mut elements = vec![];
        for span in spans {
            for original in arr(&track["elements"]) {
                let start = tick(&original["startTime"])?;
                let end = start + tick(&original["duration"])?;
                let from = start.max(span.from);
                let to = end.min(span.to);
                if from >= to {
                    continue;
                }
                let mut c = original.clone();
                if span.group.is_some() {
                    // Presentation follows its original footage. Cue-local motion
                    // and trims must not be transplanted onto a different sentence.
                    for key in ["wordRuns", "animations", "transitions"] {
                        c.as_object_mut().unwrap().remove(key);
                    }
                    c["trimStart"] = json!(0);
                    c["trimEnd"] = json!(0);
                    c["id"] = json!(fresh());
                    c["duration"] = json!(to - from);
                    ignored.push(json!({"trackId":track["id"],"elementId":c["id"]}));
                }
                c["startTime"] = json!(span.dest + from - span.from);
                elements.push(c);
            }
        }
        track["elements"] = json!(elements);
    }
    Ok(ignored)
}

pub(super) fn validate_audio(
    gaps: &[AudioGaps],
    tracks: &Value,
    ids: &[String],
) -> Result<(), String> {
    let mut seen = HashSet::new();
    if gaps.iter().map(|g| g.ranges.len()).sum::<usize>() > 360000 {
        return Err("Too many take audio gaps".into());
    }
    for g in gaps {
        if !ids.contains(&g.clip_id) || !seen.insert(&g.clip_id) {
            return Err("Invalid take audio source".into());
        }
        let clip = arr(&tracks["main"]["elements"])
            .iter()
            .find(|e| e["id"] == g.clip_id)
            .ok_or("Missing take audio source")?;
        let start = tick(&clip["startTime"]).map_err(|e| e.to_string())?;
        let end = start + tick(&clip["duration"]).map_err(|e| e.to_string())?;
        let mut previous = start;
        for (s, e) in &g.ranges {
            if *s < previous || *e <= *s || *e > end {
                return Err("Invalid take audio gap timing".into());
            }
            previous = *e;
        }
    }
    Ok(())
}
