use super::*;
use crate::studio::{STUDIO_KEY, StudioDocument};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitInput {
    project_id: String,
    expected_revision: u64,
    source: StudioDocument,
    label: String,
    #[serde(default)]
    history_group: Option<String>,
}
pub(super) fn register_studio(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<CommitInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Rewrite,
        crate::CapabilityExecution::Immediate,
        "project.studio.source.commit",
        "Commit Studio source",
        "Atomically replaces the validated HyperFrames Studio source document and immutable asset bindings. No filesystem IO. Requires project identity and revision; supports dry run, undo, idempotency and transactions. Optional historyGroup coalesces uninterrupted edits.",
        "project",
        AccessLevel::Write,
        false,
        false,
        &["studio", "hyperframes", "source", "history"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                input
                    .source
                    .validate()
                    .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                if input.label.trim().is_empty()
                    || input.label.len() > 256
                    || input
                        .history_group
                        .as_ref()
                        .is_some_and(|s| s.is_empty() || s.len() > 160)
                {
                    return Err(CapabilityError::InvalidInput(
                        "Invalid Studio edit label/group".into(),
                    ));
                }
                let output = mutate_grouped(
                    &state,
                    &events,
                    &context,
                    &input.label,
                    Some(input.expected_revision),
                    input.history_group.as_deref(),
                    |document| {
                        ensure_project_target(document, &input.project_id)?;
                        project_mut(document)?.extensions.insert(
                            STUDIO_KEY.into(),
                            serde_json::to_value(input.source)
                                .map_err(|e| CapabilityError::Failed(e.to_string()))?,
                        );
                        Ok(vec![input.project_id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Committed Studio source")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE]))
            }
        },
    )
}
