use super::*;
use crate::generative::{GenerativeDocument, Job, KEY, Message, Reference};
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    change: Change,
}
#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Change {
    Message { message: Message },
    Reference { reference: Reference },
    RemoveReference { id: String },
    Direction { text: String },
    Transcript { text: String },
    Job { job: Job },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    project_id: String,
    #[serde(default)]
    expected_revision: Option<u64>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadOutput {
    document: GenerativeDocument,
    instructions: String,
}
pub(super) fn register_generative(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let read = state.clone();
    register::<ReadInput, ReadOutput, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "project.generative.read",
        "Read The Director conversation",
        "Read canonical project direction, reference metadata, job links and Director instructions. Never includes credentials or provider authorization.",
        "generative",
        AccessLevel::Read,
        false,
        false,
        &["director", "generative", "storyboard"],
        move |_, i| {
            let state = read.clone();
            async move {
                let s = state
                    .read()
                    .map_err(|_| CapabilityError::Failed("State lock".into()))?;
                let p = s
                    .document
                    .project
                    .as_ref()
                    .ok_or_else(|| CapabilityError::InvalidInput("Open a project".into()))?;
                if p.id != i.project_id {
                    return Err(CapabilityError::Conflict("Project changed".into()));
                }
                let _ = i.expected_revision;
                let document = serde_json::from_value(
                    p.extensions
                        .get(KEY)
                        .cloned()
                        .unwrap_or(serde_json::to_value(GenerativeDocument::default()).unwrap()),
                )
                .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                Ok(OperationSuccess::new(ReadOutput {
                    document,
                    instructions: crate::generative::INSTRUCTIONS.into(),
                }))
            }
        },
    )?;
    register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "project.generative.edit",
        "Edit The Director conversation",
        "Append conversation, attach/remove reference metadata, update direction or mirror provider job links in the canonical project. No credentials, file IO, paid call or approval. Explicit project/revision, atomic Undo/Redo, dry-run and idempotency supported. Host handles authenticated IO and human-only paid approval separately.",
        "generative",
        AccessLevel::Write,
        false,
        false,
        &["director", "generative", "storyboard"],
        move |context, i| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Edit The Director",
                    Some(i.expected_revision),
                    |d| {
                        let p = project_mut(d)?;
                        if p.id != i.project_id {
                            return Err(CapabilityError::Conflict("Project changed".into()));
                        }
                        let mut value: GenerativeDocument =
                            serde_json::from_value(p.extensions.get(KEY).cloned().unwrap_or(
                                serde_json::to_value(GenerativeDocument::default()).unwrap(),
                            ))
                            .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                        match i.change {
                            Change::Message { message } => {
                                if value.messages.iter().any(|m| m.id == message.id) {
                                    return Err(CapabilityError::Conflict(
                                        "Message already exists".into(),
                                    ));
                                }
                                value.messages.push(message)
                            }
                            Change::Reference { reference } => {
                                if let Some(old) =
                                    value.references.iter_mut().find(|r| r.id == reference.id)
                                {
                                    *old = reference
                                } else {
                                    value.references.push(reference)
                                }
                            }
                            Change::RemoveReference { id } => {
                                value.references.retain(|r| r.id != id)
                            }
                            Change::Direction { text } => value.direction = text,
                            Change::Transcript { text } => value.transcript = text,
                            Change::Job { job } => {
                                if let Some(old) = value.jobs.iter_mut().find(|j| j.id == job.id) {
                                    *old = job
                                } else {
                                    value.jobs.push(job)
                                }
                            }
                        }
                        value
                            .validate()
                            .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                        p.extensions
                            .insert(KEY.into(), serde_json::to_value(value).unwrap());
                        Ok(vec![p.id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output).changed([STATE_RESOURCE, PROJECT_RESOURCE]))
            }
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::{InvocationContext, OpenCutRuntime};
    use serde_json::{Value, json};
    async fn invoke(r: &OpenCutRuntime, id: &str, input: Value) -> Value {
        r.registry()
            .invoke(id, InvocationContext::default(), input)
            .await
            .unwrap()
            .result
            .data
    }
    #[tokio::test]
    async fn director_state_is_canonical_scoped_validated_and_undoable() {
        let r = OpenCutRuntime::full_access().unwrap();
        invoke(&r, "project.create", json!({"name":"Director test"})).await;
        let d = r.snapshot().unwrap();
        let pid = d.project.unwrap().id;
        let input = json!({"projectId":pid,"expectedRevision":d.revision,"change":{"type":"message","message":{"id":"m1","role":"user","text":"Create an anime opening"}}});
        let receipt = r
            .registry()
            .invoke(
                "project.generative.edit",
                InvocationContext {
                    dry_run: true,
                    ..Default::default()
                },
                input.clone(),
            )
            .await
            .unwrap();
        assert!(!receipt.result.data.is_null());
        let before = invoke(&r, "project.generative.read", json!({"projectId":pid})).await;
        assert_eq!(before["document"]["messages"].as_array().unwrap().len(), 0);
        invoke(&r, "project.generative.edit", input).await;
        let state = invoke(&r, "app.state.read", json!({})).await;
        assert_eq!(
            state["value"]["project"]["extensions"]["generative"]["messages"][0]["text"],
            "Create an anime opening"
        );
        let read = invoke(&r, "project.generative.read", json!({"projectId":pid})).await;
        assert!(
            read["instructions"]
                .as_str()
                .unwrap()
                .contains("At most ONE")
        );
        assert!(r.registry().invoke("project.generative.edit",InvocationContext::default(),json!({"projectId":"different-project","expectedRevision":r.snapshot().unwrap().revision,"change":{"type":"direction","text":"different"}})).await.is_err());
        let revision = r.snapshot().unwrap().revision;
        assert!(r.registry().invoke("project.generative.edit",InvocationContext::default(),json!({"projectId":pid,"expectedRevision":revision,"change":{"type":"job","job":{"id":"bad","digest":"bad","status":"ready"}}})).await.is_err());
        assert_eq!(r.snapshot().unwrap().revision, revision);
        invoke(&r, "history.undo", json!({})).await;
        let after = invoke(&r, "project.generative.read", json!({"projectId":pid})).await;
        assert_eq!(after["document"]["messages"].as_array().unwrap().len(), 0);
    }
}
