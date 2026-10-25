//! Read-only grouping over registered assets. No filesystem access or inferred identity.
use super::*;
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 512))]
    media_ids: Vec<String>,
}
pub(super) fn register_groups(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
) -> Result<(), RegistryError> {
    register_camera_suggestions(registry, state.clone())?;
    register::<Input, classic_podcast::PodcastRecordingGroups, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.multicam.recordings.group",
        "Identify segmented wireless microphones",
        "Group registered completed Hollyland-style WAV exports by recording date and stable recorder filename token, preserving independent sequence counters, source asset IDs and binding revisions. Returns up to four microphone candidates and explicit blocking issues for ambiguous names, missing/duplicate segments, restart gaps and mixed sessions. Segment starts use actual durations, never rounded half hours or filename minute clocks. Read-only; no file IO. Filename evidence is not a hardware serial or proof of acoustic continuity. Bridged Classic Rust policy used by UI and MCP.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["classic", "podcast", "advanced", "microphone", "segments"],
        move |context, input| {
            let state = state.clone();
            async move {
                let store = state
                    .read()
                    .map_err(|_| CapabilityError::Failed("State lock poisoned".into()))?;
                if store.document.revision != input.expected_revision {
                    return Err(CapabilityError::Conflict(
                        "Podcast project revision changed".into(),
                    ));
                }
                let classic = store
                    .document
                    .project
                    .as_ref()
                    .filter(|p| p.id == input.project_id)
                    .and_then(|p| p.classic.as_ref())
                    .ok_or_else(|| CapabilityError::Conflict("Classic project changed".into()))?;
                if input.media_ids.is_empty()
                    || input.media_ids.len() > 512
                    || input.media_ids.iter().collect::<HashSet<_>>().len() != input.media_ids.len()
                {
                    return Err(CapabilityError::InvalidInput(
                        "Choose 1..512 unique microphone recordings".into(),
                    ));
                }
                let mut recordings = vec![];
                for id in input.media_ids {
                    if context.cancellation.is_cancelled() {
                        return Err(CapabilityError::Failed("operation was cancelled".into()));
                    }
                    let a = classic
                        .media_assets
                        .iter()
                        .find(|a| {
                            a["id"] == id
                                && a["type"] == "audio"
                                && a.get("missing") != Some(&Value::Bool(true))
                        })
                        .ok_or_else(|| {
                            CapabilityError::InvalidInput(
                                "Microphone recording is unavailable".into(),
                            )
                        })?;
                    recordings.push(classic_podcast::PodcastRecording {
                        media_id: id,
                        name: a["name"].as_str().unwrap_or("").into(),
                        duration: a.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
                        binding_revision: a
                            .get("bindingRevision")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                    });
                }
                Ok(OperationSuccess::new(
                    classic_podcast::group_podcast_recordings(
                        classic_podcast::GroupPodcastRecordingsOptions { recordings },
                    ),
                ))
            }
        },
    )
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CameraInput {
    project_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 32))]
    video_ids: Vec<String>,
    #[serde(default)]
    recording_ids: Vec<String>,
}
fn register_camera_suggestions(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
) -> Result<(), RegistryError> {
    register::<CameraInput, classic_podcast::PodcastCameraSuggestions, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.multicam.cameras.suggest",
        "Suggest podcast camera angle groups",
        "Suggest physical camera groups from shared person/group filename tokens, ignoring camera counters, Main labels and approximate angle suffix spellings. Fuzzy subject evidence is conservative and never proves synchronization. Prefers a unique Main-labelled view, leaves unrelated cameras separate, and suggests microphone bindings only from unambiguous appended recorder labels. Does not create Unified assets; physical cameras remain individually editable. Read-only, explicit project/revision; no file IO. Shared Rust policy used in Podcast dialog and MCP.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &[
            "classic", "podcast", "multicam", "angles", "main", "sources",
        ],
        move |context, input| {
            let state = state.clone();
            async move {
                let store = state
                    .read()
                    .map_err(|_| CapabilityError::Failed("State lock poisoned".into()))?;
                if store.document.revision != input.expected_revision {
                    return Err(CapabilityError::Conflict(
                        "Podcast project revision changed".into(),
                    ));
                }
                let classic = store
                    .document
                    .project
                    .as_ref()
                    .filter(|p| p.id == input.project_id)
                    .and_then(|p| p.classic.as_ref())
                    .ok_or_else(|| CapabilityError::Conflict("Classic project changed".into()))?;
                if input.video_ids.is_empty()
                    || input.video_ids.len() > 32
                    || input.recording_ids.len() > 512
                    || input.video_ids.iter().collect::<HashSet<_>>().len() != input.video_ids.len()
                    || input.recording_ids.iter().collect::<HashSet<_>>().len()
                        != input.recording_ids.len()
                {
                    return Err(CapabilityError::InvalidInput(
                        "Choose unique cameras and microphone recordings".into(),
                    ));
                }
                let mut cameras = Vec::new();
                let mut recordings = Vec::new();
                for id in input.video_ids {
                    let a = classic
                        .media_assets
                        .iter()
                        .find(|a| {
                            a["id"] == id
                                && a["type"] == "video"
                                && a.get("unifiedAngles").is_none_or(Value::is_null)
                        })
                        .ok_or_else(|| {
                            CapabilityError::InvalidInput("Choose physical cameras".into())
                        })?;
                    cameras.push(classic_podcast::NamedPodcastSource {
                        id,
                        name: a["name"].as_str().unwrap_or("").into(),
                    });
                }
                for id in input.recording_ids {
                    if context.cancellation.is_cancelled() {
                        return Err(CapabilityError::Failed("operation was cancelled".into()));
                    }
                    let a = classic
                        .media_assets
                        .iter()
                        .find(|a| a["id"] == id && a["type"] == "audio")
                        .ok_or_else(|| {
                            CapabilityError::InvalidInput("Choose external recordings".into())
                        })?;
                    recordings.push(classic_podcast::PodcastRecording {
                        media_id: id,
                        name: a["name"].as_str().unwrap_or("").into(),
                        duration: a["duration"].as_f64().unwrap_or(0.),
                        binding_revision: a
                            .get("bindingRevision")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                    });
                }
                let mut microphone_labels = vec![];
                if !recordings.is_empty() {
                    let groups = classic_podcast::group_podcast_recordings(
                        classic_podcast::GroupPodcastRecordingsOptions { recordings },
                    );
                    if groups.issues.is_empty() {
                        for m in groups.microphones {
                            let label = m.segments[0]
                                .recording
                                .name
                                .rsplit_once('.')
                                .map(|p| p.0)
                                .unwrap_or("")
                                .splitn(5, '_')
                                .nth(4)
                                .and_then(|s| s.get(4..))
                                .unwrap_or("")
                                .to_owned();
                            microphone_labels.push(classic_podcast::NamedPodcastSource {
                                id: m.id,
                                name: label,
                            });
                        }
                    }
                }
                Ok(OperationSuccess::new(
                    classic_podcast::suggest_podcast_camera_groups(
                        classic_podcast::PodcastCameraSuggestionsOptions {
                            cameras,
                            microphone_labels,
                        },
                    ),
                ))
            }
        },
    )
}
