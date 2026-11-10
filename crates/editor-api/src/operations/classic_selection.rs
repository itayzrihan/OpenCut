//! Transient Classic selection uses EditorDocument.selection, shared by UI/MCP.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Element { track_id: String, element_id: String }
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read { project_id: String }
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Change {
    Track { #[serde(rename = "trackId")] track_id: String, #[serde(default)] additive: bool },
    Elements { elements: Vec<Element>, #[serde(default, rename = "reconcileMissing")] reconcile_missing: bool, #[serde(default, rename = "preserveRowScope")] preserve_row_scope: bool },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Set { project_id: String, scene_id: String, expected_revision: u64, expected_selection_revision: Option<u64>, change: Change }
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output { project_id: String, scene_id: String, revision: u64, selection_revision: u64, elements: Vec<Element>, exact_track_id: Option<String>, changed: bool }

fn invalid(message: &str) -> CapabilityError { CapabilityError::InvalidInput(message.into()) }
fn tracks(scene: &Value) -> impl Iterator<Item = &Value> {
    let tracks = &scene["tracks"];
    std::iter::once(&tracks["main"]).chain(tracks["overlay"].as_array().into_iter().flatten()).chain(tracks["audio"].as_array().into_iter().flatten())
}
fn selected_elements(scene: &Value, selection: &SelectionState) -> Vec<Element> {
    tracks(scene).flat_map(|track| track["elements"].as_array().into_iter().flatten().filter_map(|item| {
        let id = item["id"].as_str()?;
        selection.item_ids.contains(id).then(|| Element { track_id: track["id"].as_str().unwrap().into(), element_id: id.into() })
    })).collect()
}
fn exact_track(scene: &Value, selection: &SelectionState) -> Option<String> {
    if selection.track_ids.len() != 1 || selection.item_ids.is_empty() { return None; }
    let id = selection.track_ids.first()?;
    let track = tracks(scene).find(|track| track["id"] == *id)?;
    let items = track["elements"].as_array()?;
    (items.len() == selection.item_ids.len() && items.iter().all(|item| item["id"].as_str().is_some_and(|id| selection.item_ids.contains(id)))).then(|| id.clone())
}
/// Only a deliberate whole-row selection narrows linked-edit expansion.
pub(super) fn exact_row_scope<'a>(document: &EditorDocument, scene_id: &str, refs: impl Iterator<Item = (&'a str, &'a str)>) -> bool {
    if document.classic_view_scene_id() != Some(scene_id) { return false; }
    let Some(scene) = document.project.as_ref().and_then(|p| p.classic.as_ref()).and_then(|c| c.document["scenes"].as_array()).and_then(|scenes| scenes.iter().find(|scene| scene["id"] == scene_id)) else { return false; };
    let Some(track) = exact_track(scene, &document.selection) else { return false; };
    let mut any = false;
    for (track_id, element_id) in refs {
        any = true;
        if track_id != track || !document.selection.item_ids.contains(element_id) { return false; }
    }
    any
}
fn view(document: &EditorDocument, project_id: &str) -> Result<Output, CapabilityError> {
    let project = document.project.as_ref().filter(|p| p.id == project_id).ok_or_else(|| invalid("Selection project is not active"))?;
    let classic = project.classic.as_ref().ok_or_else(|| invalid("Selection requires a Classic project"))?;
    let scene_id = document.classic_view_scene_id().ok_or_else(|| invalid("Open a scene before selecting clips"))?;
    let scene = classic.document["scenes"].as_array().unwrap().iter().find(|s| s["id"] == scene_id).unwrap();
    let elements = selected_elements(scene, &document.selection);
    Ok(Output { project_id: project_id.into(), scene_id: scene_id.into(), revision: document.revision, selection_revision: document.workspace.classic_selection_revision, elements, exact_track_id: exact_track(scene, &document.selection), changed: false })
}

pub(super) fn register_classic_selection_operations(registry: &CapabilityRegistry, state: Arc<RwLock<EditorStore>>, events: broadcast::Sender<u64>) -> Result<(), RegistryError> {
    let reading = state.clone();
    register::<Read, Output, _, _>(registry, DocumentSupport::Classic, crate::CapabilityExecution::Immediate,
        "timeline.classic.selection.read", "Read Classic clip selection", "Read the active scene's canonical selected clips without serializing project content. Selection is EditorDocument.selection, with an independent presentation revision.", "selection", AccessLevel::Read, true, false, &["classic", "selection", "track"], move |context, input| {
            let state = reading.clone(); async move {
                let store = state.read().map_err(|_| invalid("Selection state is unavailable"))?;
                check_target(&store.document, &context)?;
                Ok(OperationSuccess::new(view(&store.document, &input.project_id)?))
            }
        })?;
    register::<Set, Output, _, _>(registry, DocumentSupport::Classic, crate::CapabilityExecution::Immediate,
        "timeline.classic.selection.set", "Select Classic clips or one entire track", "Replace selection with exact existing clip references or every clip on one unlocked, nonempty active-scene track. Track additive=true retains other selected clips. Never expands groups or linked media. Selection is transient EditorDocument.selection; updates its presentation revision without changing content, Undo or dirty state. Explicit project/scene/content revision and optional selection revision, dry run, cancellation and exact retry keys. Elements reconcileMissing=true is for host restoration after structural edits: drops missing refs; ordinary input rejects them. preserveRowScope=true retains the current exact row when a host receipt selects its subset; ordinary selection clears row scope. Linked move, split and trim honor verified exact row scope. No filesystem or network.", "selection", AccessLevel::Write, true, false, &["classic", "selection", "track", "inspector"], move |context, input| {
            let state = state.clone(); let events = events.clone(); async move {
                if context.cancellation.is_cancelled() { return Err(invalid("Selection cancelled")); }
                let mut store = state.write().map_err(|_| invalid("Selection state is unavailable"))?;
                check_target(&store.document, &context)?; check_revision(&store.document, Some(input.expected_revision))?;
                let before = view(&store.document, &input.project_id)?;
                if before.scene_id != input.scene_id || input.expected_selection_revision.is_some_and(|r| r != before.selection_revision) { return Err(CapabilityError::Conflict("Selection scene or revision changed".into())); }
                let classic = store.document.project.as_ref().unwrap().classic.as_ref().unwrap();
                let scene = classic.document["scenes"].as_array().unwrap().iter().find(|s| s["id"] == input.scene_id).unwrap();
                let mut selection = SelectionState::default();
                match input.change {
                    Change::Track { track_id, additive } => {
                        let track = tracks(scene).find(|t| t["id"] == track_id).ok_or_else(|| invalid("Track not found"))?;
                        if track["locked"] == true { return Err(invalid("Unlock the track before selecting its clips")); }
                        let items = track["elements"].as_array().unwrap();
                        if items.is_empty() { return Err(invalid("Track has no clips to select")); }
                        if additive { selection.item_ids.extend(before.elements.iter().map(|e| e.element_id.clone())); }
                        selection.item_ids.extend(items.iter().map(|e| e["id"].as_str().unwrap().into()));
                        selection.track_ids.insert(track_id);
                        if exact_track(scene, &selection).is_none() { selection.track_ids.clear(); }
                    }
                    Change::Elements { elements, reconcile_missing, preserve_row_scope } => {
                        if elements.len() > 100_000 { return Err(invalid("Selection exceeds 100000 clips")); }
                        for element in elements {
                            let found = tracks(scene).any(|t| t["id"] == element.track_id && t["elements"].as_array().unwrap().iter().any(|e| e["id"] == element.element_id));
                            if found { selection.item_ids.insert(element.element_id); }
                            else if !reconcile_missing { return Err(invalid("Selection clip is missing from its track")); }
                        }
                        if preserve_row_scope && before.exact_track_id.is_some() && selection.item_ids.is_subset(&store.document.selection.item_ids) {
                            selection = store.document.selection.clone();
                        }
                    }
                }
                let changed = store.document.selection != selection;
                let revision = if changed { before.selection_revision.checked_add(1).filter(|v| *v < 9_007_199_254_740_991).ok_or_else(|| invalid("Selection revision exhausted"))? } else { before.selection_revision };
                let output = Output { elements: selected_elements(scene, &selection), exact_track_id: exact_track(scene, &selection), selection_revision: revision, changed, ..before };
                if changed && !context.dry_run { store.document.selection = selection; store.document.workspace.classic_selection_revision = revision; }
                drop(store);
                if changed && !context.dry_run { let _ = events.send(output.revision); }
                Ok(OperationSuccess::new(output).changed([STATE_RESOURCE]))
            }
        })
}
