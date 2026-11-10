use super::*;
use crate::production::*;
use serde_json::json;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    project_id: String,
    #[serde(default)]
    expected_revision: Option<u64>,
}
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadOutput {
    project_id: String,
    revision: u64,
    workspace: ProductionWorkspace,
    instructions: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditInput {
    project_id: String,
    expected_revision: u64,
    change: Change,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Change {
    ImportScript {
        row_id_prefix: String,
        text: String,
        source_language: String,
        default_duration_ms: u32,
        #[serde(default)]
        replace: bool,
    },
    CreateScriptRow {
        row_id: String,
        content: ScriptContent,
    },
    EditScriptRow {
        row_id: String,
        expected_row_version: u32,
        content: ScriptContent,
        #[serde(default)]
        change_note: String,
    },
    RestoreScriptRow {
        row_id: String,
        expected_row_version: u32,
        version: u32,
    },
    RemoveScriptRow {
        row_id: String,
        expected_row_version: u32,
    },
    CreateReferenceSlot {
        slot_id: String,
        label: String,
        #[serde(default)]
        purpose: String,
    },
    EditReferenceSlot {
        slot_id: String,
        expected_slot_version: u32,
        label: String,
        purpose: String,
    },
    AddReferenceVersion {
        slot_id: String,
        expected_slot_version: u32,
        reference_id: String,
        #[serde(default)]
        caption: String,
        source: ReferenceSource,
    },
    SelectReferenceVersion {
        slot_id: String,
        expected_slot_version: u32,
        version: u32,
    },
    ApproveReference {
        slot_id: String,
        expected_slot_version: u32,
        version: u32,
        approved: bool,
    },
    RecordAnalysis {
        analysis_id: String,
        media_id: String,
        title: String,
        source_duration_ms: u32,
        reviewed_ranges: Vec<TimeRange>,
        observations: Vec<AnalysisObservation>,
        limitations: String,
        evidence_artifact_ids: Vec<String>,
    },
    RemoveAnalysis {
        analysis_id: String,
    },
}
fn invalid(error: impl ToString) -> CapabilityError {
    CapabilityError::InvalidInput(error.to_string())
}
fn read(project: &Project) -> Result<ProductionWorkspace, CapabilityError> {
    serde_json::from_value(
        project
            .extensions
            .get(KEY)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
    )
    .map_err(invalid)
}
fn row<'a>(
    workspace: &'a mut ProductionWorkspace,
    id: &str,
    version: u32,
) -> Result<&'a mut ScriptRow, CapabilityError> {
    let row = workspace
        .script_rows
        .iter_mut()
        .find(|r| r.id == id)
        .ok_or_else(|| invalid("Script row not found"))?;
    if row.current_version != version {
        return Err(CapabilityError::Conflict(
            "This script row changed. Read the latest version; your draft must not overwrite it"
                .into(),
        ));
    }
    Ok(row)
}
fn slot<'a>(
    workspace: &'a mut ProductionWorkspace,
    id: &str,
    version: u32,
) -> Result<&'a mut ReferenceSlot, CapabilityError> {
    let slot = workspace
        .reference_slots
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| invalid("Reference slot not found"))?;
    if slot.slot_version != version {
        return Err(CapabilityError::Conflict(
            "This reference slot changed. Review its latest version before continuing".into(),
        ));
    }
    Ok(slot)
}
fn revision(
    row: &mut ScriptRow,
    content: ScriptContent,
    change_note: String,
    now: &str,
) -> Result<(), CapabilityError> {
    if row.versions.len() >= MAX_VERSIONS {
        return Err(invalid(
            "This row has reached its 32-version history limit. Create a new row to continue without deleting history",
        ));
    }
    row.current_version += 1;
    row.versions.push(ScriptVersion {
        version: row.current_version,
        created_at: now.into(),
        change_note,
        content,
    });
    Ok(())
}
pub(super) fn register_production(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    artifacts: ArtifactStore,
) -> Result<(), RegistryError> {
    register_handoff(registry, state.clone(), events.clone())?;
    let read_state = state.clone();
    register::<ReadInput, ReadOutput, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "project.production.read",
        "Read the production script, reference board and analysis guide",
        "Read the canonical production workspace and instructions. Script rows have stable IDs, original-language text, Latin transliteration, millisecond timing and immutable per-row revisions. Reference slots retain their image versions and separate current creative approval. Video-analysis observations identify reviewed ranges and actual artifact evidence; interpretations are not automatically verified. Never infer approval or paid authorization from a draft. Project/revision scoped, no IO.",
        "production",
        AccessLevel::Read,
        false,
        false,
        &[
            "production",
            "script",
            "srt",
            "transliteration",
            "references",
            "versions",
            "hook",
            "humor",
            "cta",
            "analysis",
        ],
        move |context, input| {
            let state = read_state.clone();
            async move {
                let store = state
                    .read()
                    .map_err(|_| CapabilityError::Failed("State lock".into()))?;
                check_target(&store.document, &context)?;
                check_revision(&store.document, input.expected_revision)?;
                ensure_project_target(&store.document, &input.project_id)?;
                let project = store
                    .document
                    .project
                    .as_ref()
                    .ok_or_else(|| invalid("Open a project"))?;
                Ok(OperationSuccess::new(ReadOutput {
                    project_id: project.id.clone(),
                    revision: store.document.revision,
                    workspace: read(project)?,
                    instructions: INSTRUCTIONS.into(),
                }))
            }
        },
    )?;
    register::<EditInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "project.production.edit",
        "Edit a production script row, image slot or evidence report",
        "Typed canonical production changes: import SRT or pasted lines; create/edit/restore/remove stable script rows; create/edit reference slots, add/select one image version and record creative approval; record evidence-backed video analysis. Every edit is scoped to project/expectedRevision, atomic, undoable, dry-run and registry-idempotency safe. Row/slot optimistic versions prevent overwriting concurrent drafts. Restoring a script version appends history; selecting/replacing an image clears approval and does not regenerate other slots. Reference files must already be canonical owned images. Evidence reports require real ArtifactStore IDs and reviewed ranges; no analysis or generation is fabricated by this operation. No paid calls, provider/file IO, approval of payment, or publication. Read project.production.read instructions first.",
        "production",
        AccessLevel::Write,
        false,
        false,
        &[
            "production",
            "script",
            "srt",
            "transliteration",
            "references",
            "history",
            "approve",
            "analysis",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            let artifacts = artifacts.clone();
            async move {
                let now = super::classic_scenes::timestamp()?;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Edit production workspace",
                    Some(input.expected_revision),
                    |document| {
                        ensure_project_target(document, &input.project_id)?;
                        let project = project_mut(document)?;
                        let mut workspace = read(project)?;
                        workspace.validate(project).map_err(invalid)?;
                        let changed_id = match input.change {
                            Change::ImportScript {
                                row_id_prefix,
                                text,
                                source_language,
                                default_duration_ms,
                                replace,
                            } => {
                                identifier(&row_id_prefix).map_err(invalid)?;
                                let contents =
                                    parse_script(&text, &source_language, default_duration_ms)
                                        .map_err(invalid)?;
                                if replace {
                                    workspace.script_rows.clear();
                                }
                                for (i, content) in contents.into_iter().enumerate() {
                                    let id = format!("{row_id_prefix}-{}", i + 1);
                                    if workspace.script_rows.iter().any(|r| r.id == id) {
                                        return Err(CapabilityError::Conflict(
                                            "Imported row IDs already exist".into(),
                                        ));
                                    }
                                    workspace.script_rows.push(ScriptRow {
                                        id,
                                        current_version: 1,
                                        versions: vec![ScriptVersion {
                                            version: 1,
                                            created_at: now.clone(),
                                            change_note: "Imported script".into(),
                                            content,
                                        }],
                                    });
                                }
                                row_id_prefix
                            }
                            Change::CreateScriptRow { row_id, content } => {
                                if workspace.script_rows.iter().any(|r| r.id == row_id) {
                                    return Err(CapabilityError::Conflict(
                                        "Script row already exists".into(),
                                    ));
                                }
                                workspace.script_rows.push(ScriptRow {
                                    id: row_id.clone(),
                                    current_version: 1,
                                    versions: vec![ScriptVersion {
                                        version: 1,
                                        created_at: now.clone(),
                                        change_note: "Created row".into(),
                                        content,
                                    }],
                                });
                                row_id
                            }
                            Change::EditScriptRow {
                                row_id,
                                expected_row_version,
                                content,
                                change_note,
                            } => {
                                let row = row(&mut workspace, &row_id, expected_row_version)?;
                                if row.current().content != content {
                                    revision(row, content, change_note, &now)?;
                                }
                                row_id
                            }
                            Change::RestoreScriptRow {
                                row_id,
                                expected_row_version,
                                version,
                            } => {
                                let row = row(&mut workspace, &row_id, expected_row_version)?;
                                let content = row
                                    .versions
                                    .iter()
                                    .find(|v| v.version == version)
                                    .ok_or_else(|| invalid("Script history version not found"))?
                                    .content
                                    .clone();
                                revision(
                                    row,
                                    content,
                                    format!("Restored version {version}"),
                                    &now,
                                )?;
                                row_id
                            }
                            Change::RemoveScriptRow {
                                row_id,
                                expected_row_version,
                            } => {
                                row(&mut workspace, &row_id, expected_row_version)?;
                                workspace.script_rows.retain(|r| r.id != row_id);
                                row_id
                            }
                            Change::CreateReferenceSlot {
                                slot_id,
                                label,
                                purpose,
                            } => {
                                if workspace.reference_slots.iter().any(|s| s.id == slot_id) {
                                    return Err(CapabilityError::Conflict(
                                        "Reference slot already exists".into(),
                                    ));
                                }
                                workspace.reference_slots.push(ReferenceSlot {
                                    id: slot_id.clone(),
                                    label,
                                    purpose,
                                    slot_version: 1,
                                    selected_version: None,
                                    approved_version: None,
                                    versions: vec![],
                                });
                                slot_id
                            }
                            Change::EditReferenceSlot {
                                slot_id,
                                expected_slot_version,
                                label,
                                purpose,
                            } => {
                                let s = slot(&mut workspace, &slot_id, expected_slot_version)?;
                                s.label = label;
                                s.purpose = purpose;
                                s.slot_version = s
                                    .slot_version
                                    .checked_add(1)
                                    .ok_or_else(|| invalid("Slot version overflow"))?;
                                s.approved_version = None;
                                slot_id
                            }
                            Change::AddReferenceVersion {
                                slot_id,
                                expected_slot_version,
                                reference_id,
                                caption,
                                source,
                            } => {
                                let s = slot(&mut workspace, &slot_id, expected_slot_version)?;
                                if s.versions.len() >= MAX_VERSIONS {
                                    return Err(invalid(
                                        "This reference slot reached 32 versions; keep its history and create a new slot",
                                    ));
                                }
                                let version = s.versions.len() as u32 + 1;
                                s.versions.push(ReferenceVersion {
                                    version,
                                    reference_id,
                                    caption,
                                    source,
                                    created_at: now.clone(),
                                });
                                s.selected_version = Some(version);
                                s.approved_version = None;
                                s.slot_version = s
                                    .slot_version
                                    .checked_add(1)
                                    .ok_or_else(|| invalid("Slot version overflow"))?;
                                slot_id
                            }
                            Change::SelectReferenceVersion {
                                slot_id,
                                expected_slot_version,
                                version,
                            } => {
                                let s = slot(&mut workspace, &slot_id, expected_slot_version)?;
                                if !s.versions.iter().any(|v| v.version == version) {
                                    return Err(invalid("Reference version not found"));
                                }
                                if s.selected_version != Some(version) {
                                    s.selected_version = Some(version);
                                    s.approved_version = None;
                                    s.slot_version = s
                                        .slot_version
                                        .checked_add(1)
                                        .ok_or_else(|| invalid("Slot version overflow"))?;
                                }
                                slot_id
                            }
                            Change::ApproveReference {
                                slot_id,
                                expected_slot_version,
                                version,
                                approved,
                            } => {
                                let s = slot(&mut workspace, &slot_id, expected_slot_version)?;
                                if s.selected_version != Some(version) {
                                    return Err(CapabilityError::Conflict(
                                        "Review the selected reference version before approving"
                                            .into(),
                                    ));
                                }
                                s.approved_version = if approved { Some(version) } else { None };
                                s.slot_version = s
                                    .slot_version
                                    .checked_add(1)
                                    .ok_or_else(|| invalid("Slot version overflow"))?;
                                slot_id
                            }
                            Change::RecordAnalysis {
                                analysis_id,
                                media_id,
                                title,
                                source_duration_ms,
                                reviewed_ranges,
                                observations,
                                limitations,
                                evidence_artifact_ids,
                            } => {
                                if workspace.analyses.iter().any(|a| a.id == analysis_id) {
                                    return Err(CapabilityError::Conflict("Analysis ID already exists; preserve prior evidence with a new report ID".into()));
                                }
                                if evidence_artifact_ids.is_empty()
                                    || evidence_artifact_ids.len() > 32
                                {
                                    return Err(invalid(
                                        "Analysis requires 1..32 real evidence artifacts",
                                    ));
                                }
                                let mut evidence = Vec::new();
                                for id in evidence_artifact_ids {
                                    let artifact = artifacts.get(&id).map_err(invalid)?;
                                    if artifact.metadata.byte_size == 0
                                        || !(artifact.metadata.mime_type.starts_with("image/")
                                            || artifact.metadata.mime_type.starts_with("audio/")
                                            || artifact.metadata.mime_type.contains("json")
                                            || artifact.metadata.mime_type.starts_with("text/"))
                                    {
                                        return Err(invalid(
                                            "Use frame, audio or transcript evidence artifacts",
                                        ));
                                    }
                                    if !evidence
                                        .iter()
                                        .any(|e: &ArtifactRef| e.id == artifact.metadata.id)
                                    {
                                        evidence.push(artifact.metadata);
                                    }
                                }
                                workspace.analyses.push(VideoAnalysis {
                                    id: analysis_id.clone(),
                                    media_id,
                                    source_duration_ms,
                                    created_at: now.clone(),
                                    title,
                                    reviewed_ranges,
                                    observations,
                                    limitations,
                                    evidence,
                                });
                                analysis_id
                            }
                            Change::RemoveAnalysis { analysis_id } => {
                                if !workspace.analyses.iter().any(|a| a.id == analysis_id) {
                                    return Err(invalid("Analysis not found"));
                                }
                                workspace.analyses.retain(|a| a.id != analysis_id);
                                analysis_id
                            }
                        };
                        workspace.validate(project).map_err(invalid)?;
                        project.extensions.insert(
                            KEY.into(),
                            serde_json::to_value(workspace).map_err(invalid)?,
                        );
                        Ok(vec![input.project_id.clone(), changed_id])
                    },
                )?;
                Ok(OperationSuccess::new(output).changed([STATE_RESOURCE, PROJECT_RESOURCE]))
            }
        },
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HandoffInput {
    project_id: String,
    expected_revision: u64,
    handoff_id: String,
    #[serde(default)]
    request: String,
    /// Omit to choose every currently approved slot. An empty list chooses none.
    #[serde(default)]
    approved_slot_ids: Option<Vec<String>>,
    #[serde(default)]
    storyboard_recommended: bool,
}
fn register_handoff(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<HandoffInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "project.production.handoff",
        "Send the exact production script and approved references to Director",
        "Atomically snapshot all current script rows with source-language text, Latin transliteration, timing, visuals and immutable version IDs into generative.productionHandoff. Copy source text to Director transcript and full structured instructions to direction. approvedSlotIds omitted selects all currently approved slots; explicit slots must still be selected and approved. Preserve every existing reference/version and storyboard. Duration is the latest script end in milliseconds; storyboardRecommended is optional guidance, never a prerequisite or paid action. Does not generate, approve payment or publish. Source changes invalidate captured chapter plans; create a new handoffId to send a revised script. Undo, dry-run, project revision and registry idempotency supported.",
        "production",
        AccessLevel::Write,
        false,
        false,
        &["production", "director", "handoff", "script", "references"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let now = super::classic_scenes::timestamp()?;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Send production workspace to Director",
                    Some(input.expected_revision),
                    |document| {
                        ensure_project_target(document, &input.project_id)?;
                        let project = project_mut(document)?;
                        let workspace = read(project)?;
                        workspace.validate(project).map_err(invalid)?;
                        if workspace.script_rows.is_empty() {
                            return Err(invalid("Add a script before sending it to Director"));
                        }
                        let mut director: crate::generative::GenerativeDocument =
                            serde_json::from_value(
                                project
                                    .extensions
                                    .get(crate::generative::KEY)
                                    .cloned()
                                    .unwrap_or_else(|| json!({})),
                            )
                            .map_err(invalid)?;
                        if director
                            .production_handoff
                            .as_ref()
                            .is_some_and(|handoff| handoff.id == input.handoff_id)
                        {
                            return Err(CapabilityError::Conflict(
                                "Use a new handoff ID for a revised source snapshot".into(),
                            ));
                        }
                        let selected = input.approved_slot_ids.clone().unwrap_or_else(|| {
                            workspace
                                .reference_slots
                                .iter()
                                .filter(|slot| {
                                    slot.selected_version.is_some()
                                        && slot.approved_version == slot.selected_version
                                })
                                .map(|slot| slot.id.clone())
                                .collect()
                        });
                        if selected.len() > 64
                            || selected
                                .iter()
                                .collect::<std::collections::BTreeSet<_>>()
                                .len()
                                != selected.len()
                        {
                            return Err(invalid("Choose distinct approved reference slots"));
                        }
                        let mut reference_slots = Vec::new();
                        let mut reference_ids = Vec::new();
                        for id in selected {
                            let slot = workspace
                                .reference_slots
                                .iter()
                                .find(|slot| slot.id == id)
                                .ok_or_else(|| invalid("Handoff reference slot missing"))?;
                            let version=slot.selected_version.filter(|v|Some(*v)==slot.approved_version).ok_or_else(||CapabilityError::Conflict("Approve the selected reference version before sending it to Director".into()))?;
                            let image = slot
                                .versions
                                .iter()
                                .find(|image| image.version == version)
                                .ok_or_else(|| invalid("Approved reference image missing"))?;
                            if !reference_ids.contains(&image.reference_id) {
                                reference_ids.push(image.reference_id.clone());
                            }
                            reference_slots.push(HandoffReference {
                                slot_id: slot.id.clone(),
                                slot_version: slot.slot_version,
                                version,
                                reference_id: image.reference_id.clone(),
                            });
                        }
                        let rows: Vec<HandoffRow> = workspace
                            .script_rows
                            .iter()
                            .map(|row| HandoffRow {
                                row_id: row.id.clone(),
                                version: row.current_version,
                                content: row.current().content.clone(),
                            })
                            .collect();
                        let duration_ms =
                            rows.iter().map(|row| row.content.end_ms).max().unwrap_or(0);
                        let handoff = ProductionHandoff {
                            id: input.handoff_id.clone(),
                            source_revision: input.expected_revision,
                            created_at: now.clone(),
                            request: input.request.clone(),
                            rows,
                            reference_slots,
                            reference_ids,
                            duration_ms,
                            storyboard_recommended: input.storyboard_recommended,
                        };
                        handoff.validate().map_err(invalid)?;
                        director.transcript = handoff
                            .rows
                            .iter()
                            .map(|row| row.content.source_text.as_str())
                            .collect::<Vec<_>>()
                            .join("\n");
                        director.direction=serde_json::to_string_pretty(&json!({"productionHandoff":handoff,"instructions":"Preserve exact sourceText and supplied latinTransliteration. Follow timing and visualDescription; use only captured approved referenceIds. Storyboard is optional. Discover live model durations and build canonical chapters; human review is mandatory before generation."})).map_err(invalid)?;
                        director.production_handoff = Some(handoff);
                        director.validate().map_err(invalid)?;
                        project.extensions.insert(
                            crate::generative::KEY.into(),
                            serde_json::to_value(director).map_err(invalid)?,
                        );
                        Ok(vec![input.project_id.clone(), input.handoff_id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(output).changed([STATE_RESOURCE, PROJECT_RESOURCE]))
            }
        },
    )
}
