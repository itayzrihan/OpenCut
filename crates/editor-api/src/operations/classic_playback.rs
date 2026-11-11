use super::*;

const RATES: [f64; 5] = [1.0, 1.5, 2.0, 3.0, 4.0];

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
enum Change {
    Faster,
    Slower,
    Normal,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    change: Change,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    rate: f64,
    revision: u64,
    changed: bool,
}

pub(super) fn register_shuttle(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<Input, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "playback.classic.speed.change",
        "Change Classic preview playback speed",
        "Change the active Classic viewer's speed through 1, 1.5, 2, 3 and 4. Faster cycles from 4 back to 1, slower stops at 1, and normal selects 1. Reads back at app.state.read /playback/rate. This is viewer state, independent of content history and export. Requires the active project and expected content revision. Supports dry run and retry keys; cannot run inside an editing transaction.",
        "playback",
        AccessLevel::Write,
        false,
        false,
        &["classic", "preview", "playback", "speed", "shuttle"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed(
                        "Playback speed change cancelled".into(),
                    ));
                }
                if context
                    .metadata
                    .get("opencut/transaction")
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    return Err(CapabilityError::InvalidInput(
                        "Playback speed cannot change inside an editing transaction".into(),
                    ));
                }
                let mut store = state.write().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let document = &mut store.document;
                check_target(document, &context)?;
                check_revision(document, Some(input.expected_revision))?;
                if !document.project.as_ref().is_some_and(|project| {
                    project.id == input.project_id && project.classic.is_some()
                }) {
                    return Err(CapabilityError::Conflict(
                        "Classic preview project is not active".into(),
                    ));
                }
                let current = RATES
                    .iter()
                    .position(|rate| *rate == document.playback.rate)
                    .unwrap_or(0);
                let index = match input.change {
                    Change::Faster => (current + 1) % RATES.len(),
                    Change::Slower => current.saturating_sub(1),
                    Change::Normal => 0,
                };
                let rate = RATES[index];
                let changed = rate != document.playback.rate;
                let revision = document.revision;
                if changed && !context.dry_run {
                    document.playback.rate = rate;
                }
                drop(store);
                if changed && !context.dry_run {
                    let _ = events.send(revision);
                }
                Ok(OperationSuccess::new(Output {
                    rate,
                    revision,
                    changed,
                })
                .changed([STATE_RESOURCE]))
            }
        },
    )
}
