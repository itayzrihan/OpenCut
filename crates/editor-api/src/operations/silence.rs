//! The Classic host prepares media-dependent edits; the canonical runtime owns
//! their atomic validation, publication and history boundary.
use super::*;
use crate::ClassicProject;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
enum SilenceOperation {
    SmartRemove,
    Restore,
    RepairCaptions,
}

impl SilenceOperation {
    fn label(&self) -> &'static str {
        match self {
            Self::SmartRemove => "Remove silence with speech protection",
            Self::Restore => "Restore removed silence",
            Self::RepairCaptions => "Fill captions in restored audio",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SilenceCommitInput {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    operation: SilenceOperation,
    /// Complete lossless Classic draft. Only this scene's tracks may change,
    /// plus rippled bookmarks, derived duration and modification timestamps.
    classic: ClassicProject,
}

pub(super) fn register_silence_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<SilenceCommitInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.silence.commit",
        "Commit silence edit",
        "Commits a host-prepared smart silence removal, restoration, or caption-gap repair to the explicit Classic scene. Validates the complete serialized state and rejects changes outside the target scene's tracks, rippled bookmarks (removal/restoration only), derived project duration and modification timestamps. Media analysis and transcription must finish before invocation. Supports optimistic revision checks, registry idempotency keys, dry run, transactions and undo; performs no media, network or filesystem access.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic", "bridge", "silence", "speech", "captions", "restore",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let label = input.operation.label();
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    label,
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "silence edit target project is not active".into(),
                            ));
                        }
                        let before = project.classic.as_ref().ok_or_else(|| {
                            CapabilityError::Unavailable(
                                "silence edits require a Classic project".into(),
                            )
                        })?;
                        input
                            .classic
                            .validate()
                            .map_err(|error| CapabilityError::InvalidInput(error.to_string()))?;
                        validate_scene_scope(
                            before,
                            &input.classic,
                            &input.scene_id,
                            &input.operation,
                        )?;
                        project.classic = Some(input.classic);
                        Ok(vec![input.project_id, input.scene_id])
                    },
                )?;
                Ok(OperationSuccess::new(output).summary(label).changed([
                    STATE_RESOURCE,
                    PROJECT_RESOURCE,
                    TIMELINE_RESOURCE,
                ]))
            }
        },
    )
}

fn validate_scene_scope(
    before: &ClassicProject,
    after: &ClassicProject,
    scene_id: &str,
    operation: &SilenceOperation,
) -> Result<(), CapabilityError> {
    if scene_id.is_empty()
        || before
            .document
            .get("currentSceneId")
            .and_then(Value::as_str)
            != Some(scene_id)
    {
        return Err(CapabilityError::Conflict(
            "silence edit target scene is not active".into(),
        ));
    }
    let mut allowed = before.clone();
    let next_scene = after
        .document
        .get("scenes")
        .and_then(Value::as_array)
        .and_then(|scenes| scenes.iter().find(|scene| scene["id"] == scene_id))
        .ok_or_else(|| {
            CapabilityError::InvalidInput("silence edit is missing its target scene".into())
        })?;
    let target = allowed
        .document
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .and_then(|scenes| scenes.iter_mut().find(|scene| scene["id"] == scene_id))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            CapabilityError::InvalidInput("silence edit target scene is invalid".into())
        })?;
    for key in ["tracks", "updatedAt"] {
        if let Some(value) = next_scene.get(key) {
            target.insert(key.into(), value.clone());
        }
    }
    if matches!(
        operation,
        SilenceOperation::SmartRemove | SilenceOperation::Restore
    ) && let Some(bookmarks) = next_scene.get("bookmarks")
    {
        target.insert("bookmarks".into(), bookmarks.clone());
    }
    if let Some(metadata) = allowed
        .document
        .get_mut("metadata")
        .and_then(Value::as_object_mut)
    {
        for key in ["duration", "updatedAt"] {
            if let Some(value) = after
                .document
                .get("metadata")
                .and_then(|metadata| metadata.get(key))
            {
                metadata.insert(key.into(), value.clone());
            }
        }
    }
    if &allowed != after {
        return Err(CapabilityError::InvalidInput(
            "silence edits may only change the target scene's tracks, allowed rippled bookmarks, duration and modification timestamps".into(),
        ));
    }
    Ok(())
}
