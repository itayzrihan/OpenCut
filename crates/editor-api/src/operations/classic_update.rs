//! Classic clip update policy shared by inspector, timeline gestures and agents.
use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    track_id: String,
    element_id: String,
    patch: Map<String, Value>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 1000))]
    updates: Vec<Update>,
    #[schemars(length(min = 1, max = 128))]
    history_group: Option<String>,
    /// None leaves companions unchanged, true replaces typing audio, false removes it.
    managed_typing_sfx: Option<bool>,
}
const SAFE: i64 = 9_007_199_254_740_991;
fn all(tracks: &Value) -> impl Iterator<Item = &Value> {
    std::iter::once(&tracks["main"])
        .chain(tracks["overlay"].as_array().into_iter().flatten())
        .chain(tracks["audio"].as_array().into_iter().flatten())
}
fn track_mut<'a>(tracks: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    if tracks["main"]["id"] == id {
        return tracks.get_mut("main");
    }
    tracks
        .as_object_mut()?
        .iter_mut()
        .filter(|(key, _)| matches!(key.as_str(), "overlay" | "audio"))
        .flat_map(|(_, v)| v.as_array_mut().into_iter().flatten())
        .find(|t| t["id"] == id)
}
fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn reconcile_typing(
    document: &mut EditorDocument,
    scene: &mut Value,
    before: &Value,
    updates: &[Update],
    enabled: bool,
) -> Result<(), CapabilityError> {
    let definition: Value = serde_json::from_str(include_str!(
        "../../../../classic/rust/crates/timeline/data/typing-reveal-sfx.json"
    ))
    .expect("checked typing SFX definition");
    let segment = definition["sourceTicks"].as_i64().unwrap();
    let targets: Vec<_> = updates
        .iter()
        .filter_map(|u| {
            all(before)
                .find(|t| t["id"] == u.track_id)
                .and_then(|t| t["elements"].as_array())
                .and_then(|es| {
                    es.iter()
                        .find(|e| e["id"] == u.element_id && e["type"] == "text")
                })
        })
        .collect();
    let mut planned = 0_i64;
    for text in &targets {
        planned = planned
            .checked_add(
                ticks(&text["duration"])? / segment
                    + i64::from(ticks(&text["duration"])? % segment > 0),
            )
            .ok_or_else(|| invalid("Typing SFX segment overflow"))?;
    }
    if enabled && planned > 1000 {
        return Err(invalid(
            "Typing SFX exceeds 1000 segments; split the editing request",
        ));
    }
    const KIND: &str = "opencut.typingRevealSfx.kind";
    const TEXT: &str = "opencut.typingRevealSfx.textElementId";
    for track in scene["tracks"]["audio"].as_array_mut().unwrap() {
        track["elements"].as_array_mut().unwrap().retain(|audio| {
            let managed = audio["params"][KIND] == "letter-by-letter-typing-sfx"
                && targets.iter().any(|t| t["id"] == audio["params"][TEXT]);
            let authored = audio["sourceType"] == "library"
                && audio["libraryAssetId"] == definition["assetId"]
                && targets.iter().any(|text| {
                    let a = audio["startTime"].as_i64().unwrap();
                    let ad = audio["duration"].as_i64().unwrap();
                    let b = text["startTime"].as_i64().unwrap();
                    let bd = text["duration"].as_i64().unwrap();
                    let overlap = (a + ad).min(b + bd) - a.max(b);
                    overlap.max(0) as f64 >= ad.min(bd) as f64 * 0.7
                });
            !managed && !authored
        });
    }
    if !enabled {
        return Ok(());
    }
    let mut occupied = HashSet::new();
    collect_ids(
        &serde_json::to_value(&document.project).unwrap(),
        &mut occupied,
    );
    for text in targets {
        let mut offset = 0;
        let duration = ticks(&text["duration"])?;
        let start = ticks(&text["startTime"])?;
        while offset < duration {
            let span = (duration - offset).min(segment);
            let mut audio = json!({"id":classic_duplicate::fresh(document,&mut occupied,"element"),"type":"audio","sourceType":"library","librarySourceType":"shared","libraryAssetId":definition["assetId"],"name":"Letter by letter typing SFX","startTime":start+offset,"duration":span,"trimStart":0,"trimEnd":segment-span,"sourceDuration":segment,"params":{"audioSyncOffset":0,"volume":definition["volumeDb"],"muted":false,"fadeInDuration":0,"fadeOutDuration":0,KIND:"letter-by-letter-typing-sfx",TEXT:text["id"],"opencut.typingRevealSfx.segmentIndex":offset/segment}});
            let new_track = classic_duplicate::fresh(document, &mut occupied, "track");
            classic_insert::place_library_audio(scene, &mut audio, &new_track)?;
            offset += span;
        }
    }
    Ok(())
}
fn ticks(value: &Value) -> Result<i64, CapabilityError> {
    value
        .as_i64()
        .filter(|n| (0..=SAFE).contains(n))
        .ok_or_else(|| invalid("Clip timing must be nonnegative safe integer ticks"))
}
pub(super) fn rate(element: &Value) -> f64 {
    let value = element["retime"]["rate"].as_f64().unwrap_or(1.0);
    if value <= 0.0 || !value.is_finite() {
        1.0
    } else {
        value.clamp(0.01, 5.0)
    }
}
fn round(value: f64) -> Result<i64, CapabilityError> {
    if !value.is_finite() || !(0.0..=SAFE as f64).contains(&value) {
        return Err(invalid("Clip source time overflow"));
    }
    Ok((value + 0.5).floor() as i64)
}
pub(super) fn transitions(next: &mut Value, before: &Value) -> Result<(), CapabilityError> {
    let duration = ticks(&next["duration"])?;
    let previous = ticks(&before["duration"])?;
    if let Some(map) = next.get_mut("transitions").and_then(Value::as_object_mut) {
        for (side, transition) in map {
            if !matches!(side.as_str(), "in" | "out") {
                continue;
            }
            let old = ticks(&transition["duration"])?;
            let length = old.min(duration);
            let start = transition
                .get("startTime")
                .map(ticks)
                .transpose()?
                .unwrap_or(if side == "out" {
                    (previous - old).max(0)
                } else {
                    0
                });
            let gap = (previous - start - old).max(0);
            let desired = if side == "in" {
                start
            } else {
                duration - gap - length
            };
            transition["duration"] = json!(length);
            transition["startTime"] = json!(desired.clamp(0, duration - length));
        }
    }
    Ok(())
}
fn word_content(words: &Value) -> String {
    let mut lines: BTreeMap<u64, Vec<&str>> = BTreeMap::new();
    for word in words.as_array().into_iter().flatten() {
        lines
            .entry(word["lineIndex"].as_u64().unwrap_or(0))
            .or_default()
            .push(word["text"].as_str().unwrap_or(""));
    }
    lines
        .values()
        .map(|v| v.join(" "))
        .collect::<Vec<_>>()
        .join("\n")
}
fn text_words(
    next: &mut Value,
    before: &Value,
    patch: &Map<String, Value>,
) -> Result<bool, CapabilityError> {
    if next["type"] != "text" {
        return Ok(false);
    }
    let mut extended = false;
    if patch.contains_key("wordRuns") && !patch.contains_key("duration") {
        let options = serde_json::from_value(
            json!({"duration":next["duration"],"wordRuns":next["wordRuns"]}),
        )
        .map_err(|e| invalid(&format!("Invalid word runs: {e}")))?;
        let duration =
            serde_json::to_value(classic_timeline::text_layer_duration_for_words(options)).unwrap();
        extended = duration != next["duration"];
        next["duration"] = duration;
    }
    let old = before["wordRuns"].as_array().filter(|v| !v.is_empty());
    let content_patch = patch.get("params").and_then(|p| p.get("content"));
    if let (Some(old), Some(content)) = (old, content_patch) {
        if !patch.contains_key("wordRuns")
            || word_content(&next["wordRuns"]) != content.as_str().unwrap_or("")
        {
            let options=serde_json::from_value(json!({"content":content.as_str().unwrap_or(""),"duration":next["duration"],"previousWords":old})).map_err(|e|invalid(&format!("Invalid timed text: {e}")))?;
            next["wordRuns"] = Value::Array(
                classic_timeline::reconcile_text_content_words(options)
                    .into_iter()
                    .map(|word| {
                        let mut value = word
                            .previous_word_index
                            .and_then(|i| old.get(i))
                            .cloned()
                            .unwrap_or(json!({}));
                        let fields = serde_json::to_value(word).unwrap();
                        for key in ["id", "text", "lineIndex", "startTime", "endTime"] {
                            if !fields[key].is_null() {
                                value[key] = fields[key].clone();
                            } else {
                                value.as_object_mut().unwrap().remove(key);
                            }
                        }
                        value
                    })
                    .collect(),
            );
        }
    } else if let Some(old) = old {
        if !patch.contains_key("wordRuns")
            && (patch.contains_key("trimStart") || patch.contains_key("trimEnd"))
            && (next["startTime"] != before["startTime"] || next["duration"] != before["duration"])
        {
            let options=serde_json::from_value(json!({"previousStartTime":before["startTime"],"nextStartTime":next["startTime"],"nextDuration":next["duration"],"wordRuns":old})).map_err(|e|invalid(&format!("Invalid trimmed text: {e}")))?;
            next["wordRuns"] = Value::Array(
                classic_timeline::fit_text_layer_words_to_span(options)
                    .into_iter()
                    .map(|word| {
                        let mut value = old[word.previous_word_index].clone();
                        let fields = serde_json::to_value(word).unwrap();
                        for key in ["lineIndex", "startTime", "endTime"] {
                            if !fields[key].is_null() {
                                value[key] = fields[key].clone();
                            } else {
                                value.as_object_mut().unwrap().remove(key);
                            }
                        }
                        value
                    })
                    .collect(),
            );
            next["params"]["content"] = json!(word_content(&next["wordRuns"]));
        }
    }
    Ok(extended)
}
pub(super) fn apply(
    before: &Value,
    patch: &Map<String, Value>,
    main: bool,
    earliest: Option<i64>,
    prefix: &str,
) -> Result<Value, CapabilityError> {
    if patch.keys().any(|key| {
        matches!(
            key.as_str(),
            "id" | "type"
                | "mediaId"
                | "sourceAudio"
                | "linkedSourceId"
                | "hyperframes"
                | "captionSource"
        )
    }) {
        return Err(invalid(
            "Clip identity, media/source bindings, caption sources and HyperFrames source require their dedicated capabilities",
        ));
    }
    if patch.is_empty() || serde_json::to_vec(patch).unwrap().len() > 100_000 {
        return Err(invalid("Clip patch must contain bounded fields"));
    }
    let mut next = before.clone();
    for (key, value) in patch {
        if key == "params" {
            let map = value
                .as_object()
                .ok_or_else(|| invalid("Clip params must be an object"))?;
            for (key, value) in map {
                next["params"][key] = value.clone();
            }
        } else if value.is_null() {
            next.as_object_mut().unwrap().remove(key);
        } else {
            next[key] = value.clone();
        }
    }
    let extended = text_words(&mut next, before, patch)?;
    let mut duration_changed = extended || patch.contains_key("duration");
    if patch.contains_key("retime") && matches!(before["type"].as_str(), Some("video" | "audio")) {
        let source = before
            .get("sourceDuration")
            .map(ticks)
            .transpose()?
            .map(|v| v as f64)
            .unwrap_or(
                ticks(&before["trimStart"])? as f64
                    + ticks(&before["duration"])? as f64 * rate(before)
                    + ticks(&before["trimEnd"])? as f64,
            );
        let next_rate = rate(&next);
        if next.get("retime").is_some() {
            if !next["retime"].is_object() {
                return Err(invalid("Retime must be an object or null"));
            }
            next["retime"]["rate"] = json!(next_rate);
        }
        let span =
            (source - ticks(&next["trimStart"])? as f64 - ticks(&next["trimEnd"])? as f64).max(0.0);
        next["duration"] = json!(round(span / next_rate)?);
        duration_changed = true;
    }
    if patch.contains_key("startTime") {
        let requested = next["startTime"]
            .as_i64()
            .ok_or_else(|| invalid("Clip start must be safe integer ticks"))?
            .max(0);
        next["startTime"] = json!(if main && earliest.is_none_or(|t| requested <= t) {
            0
        } else {
            requested
        });
    }
    for key in ["startTime", "duration", "trimStart", "trimEnd"] {
        ticks(&next[key])?;
    }
    if duration_changed {
        if !patch.contains_key("transitions") {
            transitions(&mut next, before)?;
        }
        let duration = ticks(&next["duration"])?;
        let animation = if duration > 0 {
            classic_keyframes::split_animations(&next["animations"], duration, prefix)?.0
        } else {
            Value::Null
        };
        if animation.is_null() {
            next.as_object_mut().unwrap().remove("animations");
        } else {
            next["animations"] = animation;
        }
    }
    Ok(next)
}
pub(super) fn register_classic_update(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.elements.update",
        "Update, trim or retime Classic clips",
        "Atomically patch 1..1000 explicit trackId/elementId clips in a Classic scene. Read the existing clip first; patch merges params and replaces other supplied serializable fields, null removes optional fields. Exact nonnegative safe integer ticks (120000/second). Retime derives duration from the original source span and clamps rate to 0.01..5; null resets retime. Duration changes anchor in/out transitions and split scalar/discrete/composite animation curves at the new boundary. Text content preserves word identity/style, explicit word insertion can extend duration, trim fits timed word runs; caption transcript/ownership is synchronized. The first main-track clip remains at zero when startTime is patched. Optional managedTypingSfx=true replaces typing companions for target text clips using the shared authored sound definition, segmented over each pre-edit text duration (maximum 1000 new segments). false removes managed or strongly overlapping authored typing audio; omitted leaves it unchanged. Unrelated audio is retained. Set the reveal-mode patch explicitly; this flag manages companion audio and does not download shared-library bytes. Linked clips change only when explicitly listed; no ripple. Identity/type/media/source-audio bindings, captionSource and HyperFrames source require dedicated capabilities. Generated caption visual reflow is excluded; use caption layout workflow. Retains all other fields and rejects duplicate/missing targets, invalid patches and incompatible state without partial writes. Supports revision, dry run, cancellation, idempotent registry retry keys and undo/redo.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic",
            "clip",
            "update",
            "trim",
            "retime",
            "speed",
            "inspector",
            "חיתוך",
            "מהירות",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let result = mutate_grouped(
                    &state,
                    &events,
                    &context,
                    "Update Classic clips",
                    Some(input.expected_revision),
                    input.history_group.as_deref(),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "Clip update target is not active".into(),
                            ));
                        }
                        let mut scene = project
                            .classic
                            .as_mut()
                            .ok_or_else(|| invalid("Requires Classic project"))?
                            .document["scenes"]
                            .as_array()
                            .and_then(|v| v.iter().find(|s| s["id"] == input.scene_id))
                            .ok_or_else(|| invalid("Scene not found"))?
                            .clone();
                        let before = scene["tracks"].clone();
                        let tracks = &mut scene["tracks"];
                        let mut seen = HashSet::new();
                        for update in &input.updates {
                            if !seen.insert(&update.element_id) {
                                return Err(invalid("Duplicate clip update"));
                            }
                            let location = all(tracks)
                                .find(|t| t["id"] == update.track_id)
                                .ok_or_else(|| invalid("Track not found"))?;
                            let original = location["elements"]
                                .as_array()
                                .and_then(|v| v.iter().find(|e| e["id"] == update.element_id))
                                .cloned()
                                .ok_or_else(|| invalid("Clip not found in target track"))?;
                            let main = tracks["main"]["id"] == update.track_id;
                            let earliest = if main {
                                location["elements"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .filter(|e| e["id"] != update.element_id)
                                    .map(|e| ticks(&e["startTime"]))
                                    .collect::<Result<Vec<_>, _>>()?
                                    .into_iter()
                                    .min()
                            } else {
                                None
                            };
                            let prefix = format!(
                                "trim-{:x}",
                                Sha256::digest(format!(
                                    "{}:{}:{}",
                                    input.scene_id, update.element_id, input.expected_revision
                                ))
                            );
                            let next = apply(&original, &update.patch, main, earliest, &prefix)?;
                            let track = track_mut(tracks, &update.track_id)
                                .ok_or_else(|| invalid("Track not found"))?;
                            let target = track["elements"]
                                .as_array_mut()
                                .unwrap()
                                .iter_mut()
                                .find(|e| e["id"] == update.element_id)
                                .unwrap();
                            *target = next;
                        }
                        classic_captions::sync_after_edit(tracks, &before, &json!(input.updates))?;
                        if let Some(enabled) = input.managed_typing_sfx {
                            reconcile_typing(
                                document,
                                &mut scene,
                                &before,
                                &input.updates,
                                enabled,
                            )?;
                        }
                        *project_mut(document)?.classic.as_mut().unwrap().document["scenes"]
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|s| s["id"] == input.scene_id)
                            .unwrap() = scene;
                        Ok(input.updates.iter().map(|u| u.element_id.clone()).collect())
                    },
                )?;
                Ok(OperationSuccess::new(result).changed([
                    STATE_RESOURCE,
                    PROJECT_RESOURCE,
                    TIMELINE_RESOURCE,
                ]))
            }
        },
    )
}
