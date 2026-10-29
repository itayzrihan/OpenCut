//! Canonical parameter and source edits for code-based Earshot clips.
use super::*;
use crate::ProceduralAudioSource;
use serde_json::json;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    track_id: String,
    element_id: String,
    procedural: ProceduralAudioSource,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 100))]
    updates: Vec<Update>,
    #[serde(default)]
    #[schemars(length(min = 1, max = 128))]
    history_group: Option<String>,
}

pub(super) fn register(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    super::register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.audio.procedural.set",
        "Edit code-based Earshot sound effects",
        "Replace the bounded procedural source of 1..100 existing Earshot audio clips. The serialized source contains the pinned bank revision, preset ID, deterministic seed, full duration in seconds, optional apex/pitch/numeric parameters/Python source override/echo. Source code is inert here: the isolated audio host synthesizes preview/export PCM without importing a media file. Numeric pitch is Hz; note strings use scientific notation. Recomputes sourceDuration and visible duration from the new source, existing trims and playback rate; preserves placement, fades, volume and unrelated edits. Rejects sources shorter than retained trims and locked tracks. To create a sound, use timeline.classic.elements.insert with type audio and sourceType procedural. Explicit project/scene/current expectedRevision, dry run, cancellation, idempotent retries, atomic rollback and Undo/Redo. Read the source through app.state.read under the clip. Classic renderer feature bridged through the canonical runtime.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic",
            "audio",
            "procedural",
            "earshot",
            "sound-effects",
            "code",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let mutation = mutate_grouped(
                    &state,
                    &events,
                    &context,
                    "Edit Earshot sound effects",
                    Some(input.expected_revision),
                    input.history_group.as_deref(),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "Procedural audio project is not active".into(),
                            ));
                        }
                        let classic = project
                            .classic
                            .as_mut()
                            .ok_or_else(|| invalid("Requires a Classic project"))?;
                        let scene = classic.document["scenes"]
                            .as_array_mut()
                            .and_then(|scenes| {
                                scenes
                                    .iter_mut()
                                    .find(|scene| scene["id"] == input.scene_id)
                            })
                            .ok_or_else(|| invalid("Scene not found"))?;
                        let mut seen = HashSet::new();
                        for update in &input.updates {
                            if !seen.insert(&update.element_id) {
                                return Err(invalid("Duplicate procedural audio target"));
                            }
                            update
                                .procedural
                                .validate()
                                .map_err(|message| invalid(&message))?;
                            let track = scene["tracks"]["audio"]
                                .as_array_mut()
                                .and_then(|tracks| {
                                    tracks
                                        .iter_mut()
                                        .find(|track| track["id"] == update.track_id)
                                })
                                .ok_or_else(|| invalid("Procedural audio track not found"))?;
                            if track["locked"] == true {
                                return Err(invalid(
                                    "Unlock the audio track before editing its source",
                                ));
                            }
                            let target = track["elements"]
                                .as_array_mut()
                                .and_then(|elements| {
                                    elements
                                        .iter_mut()
                                        .find(|element| element["id"] == update.element_id)
                                })
                                .ok_or_else(|| invalid("Procedural audio clip not found"))?;
                            if target["type"] != "audio" || target["sourceType"] != "procedural" {
                                return Err(invalid(
                                    "This action only edits existing procedural audio clips",
                                ));
                            }
                            let source_duration = update.procedural.source_ticks();
                            let trims = target["trimStart"].as_i64().unwrap_or(0)
                                + target["trimEnd"].as_i64().unwrap_or(0);
                            if trims >= source_duration {
                                return Err(invalid(
                                    "The new source must extend beyond the retained trims",
                                ));
                            }
                            let duration = ((source_duration - trims) as f64
                                / classic_update::rate(target))
                            .round() as i64;
                            let patch = json!({"procedural":update.procedural,"sourceDuration":source_duration,"duration":duration});
                            *target = classic_update::apply(
                                target,
                                patch.as_object().unwrap(),
                                false,
                                None,
                                &format!(
                                    "earshot-{}-{}",
                                    update.element_id, input.expected_revision
                                ),
                            )?;
                        }
                        Ok(input
                            .updates
                            .iter()
                            .map(|update| update.element_id.clone())
                            .collect())
                    },
                )?;
                Ok(OperationSuccess::new(mutation).changed([
                    STATE_RESOURCE,
                    PROJECT_RESOURCE,
                    TIMELINE_RESOURCE,
                ]))
            }
        },
    )
}

fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
