//! Atomic text merging with transcript ownership reconciliation.
use super::*;
use serde_json::json;
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ref {
    track_id: String,
    element_id: String,
}
#[derive(Default, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
enum Mode {
    #[default]
    SingleLine,
    Multiline,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[serde(default)]
    mode: Mode,
    #[schemars(length(min = 2, max = 1000))]
    elements: Vec<Ref>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    #[serde(flatten)]
    mutation: MutationOutput,
    target: Ref,
    removed: Vec<Ref>,
}
fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn all(tracks: &Value) -> impl Iterator<Item = &Value> {
    std::iter::once(&tracks["main"])
        .chain(tracks["overlay"].as_array().into_iter().flatten())
        .chain(tracks["audio"].as_array().into_iter().flatten())
}
pub(super) fn register_classic_text_merge(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<Input, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.text.merge",
        "Merge Classic text clips",
        "Merge 2..1000 explicit text clips in one project/scene. Validates all targets and rejects duplicates or non-text clips atomically. Earliest clip (stable lexicographic ID tie-break) supplies visual style, animations, transitions and the retained identity/track. Duration covers the complete min-start/max-end span; trims reset to zero. Single-line joins styled word runs into one line, retaining absolute word timing as relative ticks. Multiline uses one row per source clip, strips word timings and disables caption word/reveal entrance animation, matching the editor's multiline behavior. Remaps word/row identities, clamps transitions to the new edges, reconciles manual transcript ownership without deleting generated transcript words. Keeps empty source tracks, media and unrelated fields. Does not re-measure fonts or regenerate generated caption visual layout. Returns retained and removed references; readback via app.state.read. Exact ticks, optimistic revision, dry run, idempotent retries, cancellation, one transaction and Undo/Redo.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["classic", "text", "merge", "caption", "מיזוג", "טקסט"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let mut target = Ref {
                    track_id: String::new(),
                    element_id: String::new(),
                };
                let mut removed = Vec::new();
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Merge text clips",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "Text merge target project changed".into(),
                            ));
                        }
                        let original = project
                            .classic
                            .as_ref()
                            .ok_or_else(|| invalid("Requires Classic project"))?
                            .document["scenes"]
                            .as_array()
                            .and_then(|v| v.iter().find(|s| s["id"] == input.scene_id))
                            .ok_or_else(|| invalid("Scene not found"))?["tracks"]
                            .clone();
                        let mut entries = Vec::new();
                        let mut seen = HashSet::new();
                        for reference in &input.elements {
                            if !seen.insert((&reference.track_id, &reference.element_id)) {
                                return Err(invalid("Duplicate text merge reference"));
                            }
                            let element = all(&original)
                                .find(|t| t["id"] == reference.track_id && t["type"] == "text")
                                .and_then(|t| t["elements"].as_array())
                                .and_then(|v| {
                                    v.iter().find(|e| {
                                        e["id"] == reference.element_id && e["type"] == "text"
                                    })
                                })
                                .ok_or_else(|| invalid("Text merge clip not found"))?;
                            entries.push((
                                reference.clone(),
                                element.clone(),
                                classic_text::tick(&element["startTime"])?,
                            ));
                        }
                        entries.sort_by(|a, b| {
                            a.2.cmp(&b.2)
                                .then_with(|| a.0.element_id.cmp(&b.0.element_id))
                        });
                        let start = entries[0].2;
                        let end = entries
                            .iter()
                            .map(|v| {
                                v.2.checked_add(classic_text::tick(&v.1["duration"])?)
                                    .filter(|v| *v <= crate::classic::MAX_SAFE_INTEGER)
                                    .ok_or_else(|| invalid("Merged end exceeds safe ticks"))
                            })
                            .collect::<Result<Vec<_>, _>>()?
                            .into_iter()
                            .max()
                            .unwrap();
                        let duration = (end - start).max(1);
                        let mut words = Vec::new();
                        for (index, (_, element, time)) in entries.iter().enumerate() {
                            if context.cancellation.is_cancelled() {
                                return Err(CapabilityError::Failed(
                                    "operation was cancelled".into(),
                                ));
                            }
                            for (run, s, e, line) in classic_text::timed_words(element)? {
                                let offset = time - start;
                                let s = s
                                    .checked_add(offset)
                                    .filter(|v| *v <= crate::classic::MAX_SAFE_INTEGER)
                                    .ok_or_else(|| invalid("Merged word start overflows"))?;
                                let e = e
                                    .checked_add(offset)
                                    .filter(|v| *v <= crate::classic::MAX_SAFE_INTEGER)
                                    .ok_or_else(|| invalid("Merged word end overflows"))?;
                                words.push((
                                    run,
                                    s,
                                    e,
                                    if matches!(input.mode, Mode::Multiline) {
                                        index as u64
                                    } else {
                                        line
                                    },
                                ));
                            }
                        }
                        target = entries[0].0.clone();
                        removed = entries.iter().skip(1).map(|v| v.0.clone()).collect();
                        let mut merged = classic_text::build_part(
                            &entries[0].1,
                            words,
                            0,
                            duration,
                            matches!(input.mode, Mode::SingleLine),
                            matches!(input.mode, Mode::Multiline),
                        );
                        merged["startTime"] = json!(start);
                        if matches!(input.mode, Mode::Multiline) {
                            merged["captionWordAnimationId"] = json!("none");
                            merged["captionRevealMode"] = json!("row");
                            merged["captionTransitionIn"] = json!("none");
                        }
                        if let Some(transitions) =
                            merged.get_mut("transitions").and_then(Value::as_object_mut)
                        {
                            for side in ["in", "out"] {
                                if let Some(transition) =
                                    transitions.get_mut(side).filter(|v| v.is_object())
                                {
                                    let span =
                                        classic_text::tick(&transition["duration"])?.min(duration);
                                    transition["duration"] = json!(span);
                                    transition["startTime"] =
                                        json!(if side == "in" { 0 } else { duration - span });
                                }
                            }
                            if transitions.is_empty() {
                                merged.as_object_mut().unwrap().remove("transitions");
                            }
                        }
                        let mut tracks = original.clone();
                        for track in tracks
                            .as_object_mut()
                            .unwrap()
                            .iter_mut()
                            .filter(|(key, _)| matches!(key.as_str(), "main" | "overlay" | "audio"))
                            .flat_map(|(key, value)| {
                                if key == "main" {
                                    vec![value]
                                } else {
                                    value.as_array_mut().unwrap().iter_mut().collect()
                                }
                            })
                        {
                            let id = track["id"].as_str().unwrap().to_owned();
                            let elements = track["elements"].as_array_mut().unwrap();
                            elements.retain(|e| {
                                !removed
                                    .iter()
                                    .any(|v| v.track_id == id && e["id"] == v.element_id)
                            });
                            if id == target.track_id {
                                *elements
                                    .iter_mut()
                                    .find(|e| e["id"] == target.element_id)
                                    .unwrap() = merged.clone();
                            }
                        }
                        let mut manual: Vec<_> = removed
                            .iter()
                            .map(|v| classic_remove::ElementRef {
                                track_id: v.track_id.clone(),
                                element_id: v.element_id.clone(),
                            })
                            .collect();
                        if matches!(input.mode, Mode::Multiline) {
                            manual.push(classic_remove::ElementRef {
                                track_id: target.track_id.clone(),
                                element_id: target.element_id.clone(),
                            });
                        }
                        classic_captions::reconcile_words(&mut tracks, &manual)?;
                        let scene =
                            project_mut(document)?.classic.as_mut().unwrap().document["scenes"]
                                .as_array_mut()
                                .unwrap()
                                .iter_mut()
                                .find(|s| s["id"] == input.scene_id)
                                .unwrap();
                        scene["tracks"] = tracks;
                        Ok(input
                            .elements
                            .iter()
                            .map(|v| v.element_id.clone())
                            .collect())
                    },
                )?;
                Ok(OperationSuccess::new(Output {
                    mutation,
                    target,
                    removed,
                })
                .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
