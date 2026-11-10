use super::*;
use crate::audio_production::{AudioDraft, AudioProduction, KEY};
use serde_json::json;
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    project_id: String,
    #[serde(default)]
    expected_revision: Option<u64>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Edit {
    project_id: String,
    expected_revision: u64,
    expected_draft_version: Option<u64>,
    draft: AudioDraft,
}
pub(super) fn register_audio_production(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let read = state.clone();
    register::<Read, AudioProduction, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "project.audio.read",
        "Read audio production drafts",
        "Read canonical ElevenLabs speech, dialogue, sound effects and music drafts. No credentials or network requests.",
        "audio",
        AccessLevel::Read,
        false,
        false,
        &["elevenlabs", "speech", "music", "sound", "director"],
        move |context, i| {
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
                if p.id != i.project_id
                    || i.expected_revision
                        .is_some_and(|r| r != s.document.revision)
                    || context
                        .metadata
                        .get("opencut/projectId")
                        .is_some_and(|v| v.as_str() != Some(&i.project_id))
                {
                    return Err(CapabilityError::Conflict("Project changed".into()));
                }
                let doc: AudioProduction =
                    serde_json::from_value(p.extensions.get(KEY).cloned().unwrap_or(json!({})))
                        .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                Ok(OperationSuccess::new(doc))
            }
        },
    )?;
    register::<Edit, MutationOutput, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "project.audio.draft.edit",
        "Prepare or revise audio direction",
        "Create/update a canonical audio draft for The Director Audio tab. Speech uses the original language, not transliteration. Support speech, multivoice dialogue (max2000 characters/10voices), sound effects (0.5–30s) and music (3–600s). Set version1 fornew, existingversion+1 forupdate and expectedDraftVersion. No paid generation: project.audio.request prepares human PIN review. Undo, dry-run and idempotency supported.",
        "audio",
        AccessLevel::Write,
        false,
        false,
        &["elevenlabs", "speech", "music", "sound", "director"],
        move |context, i| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Edit audio production",
                    Some(i.expected_revision),
                    |d| {
                        let p = project_mut(d)?;
                        if p.id != i.project_id {
                            return Err(CapabilityError::Conflict("Project changed".into()));
                        }
                        let mut doc: AudioProduction = serde_json::from_value(
                            p.extensions.get(KEY).cloned().unwrap_or(json!({})),
                        )
                        .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                        if let Some(old) = doc.drafts.iter_mut().find(|v| v.id == i.draft.id) {
                            if Some(old.version) != i.expected_draft_version
                                || i.draft.version != old.version + 1
                            {
                                return Err(CapabilityError::Conflict(
                                    "Audio draft version changed".into(),
                                ));
                            }
                            *old = i.draft;
                        } else {
                            if i.expected_draft_version.is_some() || i.draft.version != 1 {
                                return Err(CapabilityError::Conflict(
                                    "New audio draft starts at version1".into(),
                                ));
                            }
                            doc.drafts.push(i.draft);
                        }
                        doc.validate()
                            .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                        p.extensions
                            .insert(KEY.into(), serde_json::to_value(doc).unwrap());
                        Ok(vec![p.id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output).changed([STATE_RESOURCE, PROJECT_RESOURCE]))
            }
        },
    )?;
    Ok(())
}
