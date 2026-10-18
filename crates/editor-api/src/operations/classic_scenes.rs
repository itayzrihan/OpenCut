//! Classic scene lifecycle. UI and agents invoke these same transactions.
use super::*;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum SceneChange {
    Create {
        #[serde(rename = "sceneId")]
        scene_id: String,
        #[serde(rename = "mainTrackId")]
        main_track_id: String,
        name: String,
        #[serde(default, rename = "isMain")]
        is_main: bool,
    },
    Rename {
        #[serde(rename = "sceneId")]
        scene_id: String,
        name: String,
    },
    Select {
        #[serde(rename = "sceneId")]
        scene_id: String,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SceneEditInput {
    project_id: String,
    expected_revision: u64,
    change: SceneChange,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SceneDeleteInput {
    project_id: String,
    expected_revision: u64,
    scene_id: String,
}

pub(super) fn timestamp() -> Result<String, CapabilityError> {
    chrono::DateTime::from_timestamp_millis(now_ms() as i64)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| CapabilityError::Failed("host clock is outside supported date range".into()))
}

pub(super) fn classic_target<'a>(
    document: &'a mut EditorDocument,
    project_id: &str,
) -> Result<&'a mut crate::ClassicProject, CapabilityError> {
    let project = project_mut(document)?;
    if project.id != project_id {
        return Err(CapabilityError::Conflict(
            "scene edit target project is not active".into(),
        ));
    }
    project.classic.as_mut().ok_or_else(|| {
        CapabilityError::Unavailable("scene editing requires a Classic project".into())
    })
}

pub(super) fn register_classic_scene_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register_navigation(registry, state.clone(), events.clone())?;
    let edit_state = state.clone();
    let edit_events = events.clone();
    register::<SceneEditInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "project.classic.scenes.edit",
        "Create, rename or select a Classic scene",
        "Create an empty Classic scene with fresh caller-provided sceneId and mainTrackId, rename a scene, or select the scene shown in the editor. Read scene IDs at app.state.read /project/classic/document/scenes. Creating does not switch the active scene. Preserves all media, composition sources, other scenes and unknown fields. Scene selection is undoable. Requires projectId and expectedRevision; supports dry run, cancellation, atomic transactions and registry idempotency keys. Removing scenes from the timeline uses project.classic.scene.delete.",
        "scene",
        AccessLevel::Write,
        false,
        false,
        &["classic", "scene", "create", "rename", "select"],
        move |context, input| {
            let state = edit_state.clone();
            let events = edit_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Edit scene",
                    Some(input.expected_revision),
                    |document| {
                        if matches!(&input.change, SceneChange::Select { .. }) {
                            document.workspace.classic_scene = None;
                        }
                        let classic = classic_target(document, &input.project_id)?;
                        let now = timestamp()?;
                        let id = apply_change(classic, input.change, &now)?;
                        classic.document.get_mut("metadata").unwrap()["updatedAt"] =
                            Value::String(now);
                        Ok(vec![input.project_id, id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated Classic scene")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )?;
    register::<SceneDeleteInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "project.classic.scene.delete",
        "Delete a Classic scene",
        "Remove a non-main scene and its timeline content. If it is active, select the remaining main scene. Main scenes cannot be removed. Shared media and HyperFrames composition sources are retained, so other scenes and undo history remain valid. Requires projectId, sceneId and expectedRevision; supports dry run, cancellation, atomic transactions, undo/redo and registry idempotency keys.",
        "scene",
        // Reversible document edit: no file, media, or source bytes are removed.
        AccessLevel::Write,
        false,
        false,
        &["classic", "scene", "delete"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Delete scene",
                    Some(input.expected_revision),
                    |document| {
                        let classic = classic_target(document, &input.project_id)?;
                        let active = classic.document["currentSceneId"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned();
                        let scenes = classic
                            .document
                            .get_mut("scenes")
                            .and_then(Value::as_array_mut)
                            .unwrap();
                        let index = scenes
                            .iter()
                            .position(|scene| scene["id"] == input.scene_id)
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput("Classic scene not found".into())
                            })?;
                        if scenes[index]["isMain"] == true {
                            return Err(CapabilityError::InvalidInput(
                                "Cannot delete main scene".into(),
                            ));
                        }
                        scenes.remove(index);
                        if active == input.scene_id {
                            let fallback = scenes
                                .iter()
                                .find(|scene| scene["isMain"] == true)
                                .ok_or_else(|| {
                                    CapabilityError::InvalidInput(
                                        "Cannot remove the active scene without a main scene"
                                            .into(),
                                    )
                                })?;
                            let fallback = fallback["id"].clone();
                            classic.document.insert("currentSceneId".into(), fallback);
                        }
                        classic.document.get_mut("metadata").unwrap()["updatedAt"] =
                            Value::String(timestamp()?);
                        Ok(vec![input.project_id, input.scene_id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Deleted Classic scene")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NavigationInput {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[serde(default)]
    expected_navigation_revision: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NavigationReadInput { project_id: String }

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct NavigationOutput {
    project_id: String,
    scene_id: String,
    revision: u64,
    navigation_revision: u64,
    changed: bool,
    viewport: Option<crate::ClassicViewport>,
}

fn navigation_view(document: &EditorDocument, project_id: &str) -> Result<NavigationOutput, CapabilityError> {
    let project = document.project.as_ref().filter(|p| p.id == project_id)
        .ok_or_else(|| CapabilityError::Conflict("Classic navigation project is not active".into()))?;
    let classic = project.classic.as_ref().ok_or_else(|| CapabilityError::Unavailable("Classic navigation requires a Classic project".into()))?;
    let scenes = classic.document["scenes"].as_array().ok_or_else(|| CapabilityError::Failed("Classic scenes are unavailable".into()))?;
    let scene = document.workspace.classic_scene.as_ref().filter(|navigation|
        navigation.project_id == project_id && scenes.iter().any(|s| s["id"] == navigation.scene_id));
    let scene_id = scene.map(|s| s.scene_id.as_str()).unwrap_or_else(|| classic.document["currentSceneId"].as_str().unwrap_or_default());
    Ok(NavigationOutput { project_id: project_id.into(), scene_id: scene_id.into(), revision: document.revision,
        navigation_revision: document.workspace.classic_scene_revision, changed: false,
        viewport: document.workspace.classic_viewport.clone().filter(|v| v.project_id == project_id) })
}

fn register_navigation(registry: &CapabilityRegistry, state: Arc<RwLock<EditorStore>>, events: broadcast::Sender<u64>) -> Result<(), RegistryError> {
    register_viewport(registry, state.clone(), events.clone())?;
    let read_state = state.clone();
    register::<NavigationReadInput, NavigationOutput, _, _>(registry, DocumentSupport::Classic, crate::CapabilityExecution::Immediate,
        "project.classic.scene.view", "Read the current Classic viewer",
        "Read the canonical workspace viewer scene, falling back to the persisted editing scene. Returns IDs and revisions only; never serializes clips, captions, media or history.",
        "scene", AccessLevel::Read, true, false, &["classic", "scene", "workspace", "navigation"], move |_, input| {
            let state = read_state.clone(); async move {
                let store = state.read().map_err(|_| CapabilityError::Failed("editor state lock was poisoned".into()))?;
                Ok(OperationSuccess::new(navigation_view(&store.document, &input.project_id)?))
            }
        })?;
    register::<NavigationInput, NavigationOutput, _, _>(registry, DocumentSupport::Classic, crate::CapabilityExecution::Immediate,
        "project.classic.scene.open", "Open a Classic scene in the viewer",
        "Navigate the canonical workspace to an existing scene without editing clips, copying the project, creating Undo entries, changing the content revision or archiving history. The legacy scenes.edit select remains an undoable edit. Project and optional navigation revisions are fenced. Dry run and retry keys supported; cannot run inside content transactions. Viewer state is serializable under workspace.classicScene; hosts may checkpoint it separately and must restore through this capability.",
        "scene", AccessLevel::Write, true, false, &["classic", "scene", "workspace", "navigation", "sequence"], move |context, input| {
            let state = state.clone(); let events = events.clone(); async move {
                for id in [&input.project_id, &input.scene_id] {
                    if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
                        return Err(CapabilityError::InvalidInput("invalid viewer identity".into()));
                    }
                }
                if context.cancellation.is_cancelled() { return Err(CapabilityError::Failed("navigation cancelled".into())); }
                if context.metadata.get("opencut/transaction").and_then(Value::as_bool) == Some(true) {
                    return Err(CapabilityError::InvalidInput("viewer navigation cannot run inside an editing transaction".into()));
                }
                let mut store = state.write().map_err(|_| CapabilityError::Failed("editor state lock was poisoned".into()))?;
                check_target(&store.document, &context)?;
                check_revision(&store.document, Some(input.expected_revision))?;
                let mut output = navigation_view(&store.document, &input.project_id)?;
                if input.expected_navigation_revision.is_some_and(|expected| expected != output.navigation_revision) {
                    return Err(CapabilityError::Conflict("Classic navigation revision changed".into()));
                }
                let classic = store.document.project.as_ref().unwrap().classic.as_ref().unwrap();
                if !classic.document["scenes"].as_array().unwrap().iter().any(|s| s["id"] == input.scene_id) {
                    return Err(CapabilityError::InvalidInput("Classic scene not found".into()));
                }
                output.changed = output.scene_id != input.scene_id;
                output.scene_id = input.scene_id.clone();
                if output.changed {
                    output.navigation_revision = output.navigation_revision.checked_add(1).filter(|r| *r < 9_007_199_254_740_991)
                        .ok_or_else(|| CapabilityError::Failed("navigation revision exhausted".into()))?;
                    if !context.dry_run {
                        store.document.workspace.classic_scene = Some(crate::ClassicSceneNavigation { project_id: input.project_id, scene_id: input.scene_id });
                        store.document.workspace.classic_scene_revision = output.navigation_revision;
                    }
                }
                drop(store);
                if output.changed && !context.dry_run { let _ = events.send(output.revision); }
                Ok(OperationSuccess::new(output).summary("Opened Classic viewer scene").changed([STATE_RESOURCE]))
            }
        })
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ViewportInput { project_id: String, expected_revision: u64, zoom_level: f64, scroll_left: f64, playhead_time: i64 }

fn register_viewport(registry: &CapabilityRegistry, state: Arc<RwLock<EditorStore>>, events: broadcast::Sender<u64>) -> Result<(), RegistryError> {
    register::<ViewportInput, NavigationOutput, _, _>(registry, DocumentSupport::Classic, crate::CapabilityExecution::Immediate,
        "project.classic.viewport.set", "Set Classic viewport presentation",
        "Set canonical workspace zoom, horizontal scroll and playhead presentation without editing content, creating Undo or archiving the project. Requires active project and content revision. Finite positive zoom, nonnegative scroll and safe tick position are validated. Supports dry run and retries; cannot run inside content transactions. Hosts checkpoint tiny viewer preferences separately.",
        "scene", AccessLevel::Write, true, false, &["classic","workspace","viewport","navigation"], move |context, input| {
            let state = state.clone(); let events = events.clone(); async move {
                if context.cancellation.is_cancelled() { return Err(CapabilityError::Failed("viewport update cancelled".into())); }
                if context.metadata.get("opencut/transaction").and_then(Value::as_bool) == Some(true) { return Err(CapabilityError::InvalidInput("viewport cannot run inside an editing transaction".into())); }
                if input.project_id.is_empty() || input.project_id.len() > 256 || !input.zoom_level.is_finite() || input.zoom_level <= 0.0 || !input.scroll_left.is_finite() || input.scroll_left < 0.0 || input.playhead_time < 0 || input.playhead_time > 9_007_199_254_740_991 { return Err(CapabilityError::InvalidInput("invalid viewport values".into())); }
                let mut store = state.write().map_err(|_| CapabilityError::Failed("editor state lock was poisoned".into()))?;
                check_target(&store.document, &context)?; check_revision(&store.document, Some(input.expected_revision))?;
                let mut output = navigation_view(&store.document, &input.project_id)?;
                let viewport = crate::ClassicViewport { project_id: input.project_id, zoom_level: input.zoom_level, scroll_left: input.scroll_left, playhead_time: input.playhead_time };
                output.changed = store.document.workspace.classic_viewport.as_ref() != Some(&viewport);
                output.viewport = Some(viewport.clone());
                if output.changed && !context.dry_run { store.document.workspace.classic_viewport = Some(viewport); }
                drop(store);
                if output.changed && !context.dry_run { let _ = events.send(output.revision); }
                Ok(OperationSuccess::new(output).changed([STATE_RESOURCE]))
            }
        })
}

fn valid_text(value: &str, max: usize, name: &str) -> Result<(), CapabilityError> {
    if value.trim().is_empty() || value.len() > max {
        return Err(CapabilityError::InvalidInput(format!(
            "{name} must contain 1 to {max} UTF-8 bytes"
        )));
    }
    Ok(())
}

fn apply_change(
    classic: &mut crate::ClassicProject,
    change: SceneChange,
    now: &str,
) -> Result<String, CapabilityError> {
    let scenes = classic
        .document
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .unwrap();
    match change {
        SceneChange::Create {
            scene_id,
            main_track_id,
            name,
            is_main,
        } => {
            valid_text(&scene_id, 160, "sceneId")?;
            valid_text(&main_track_id, 160, "mainTrackId")?;
            valid_text(&name, 1024, "scene name")?;
            if scenes.iter().any(|scene| scene["id"] == scene_id) {
                return Err(CapabilityError::Conflict("scene ID already exists".into()));
            }
            // Full Classic validation checks track/element IDs across every scene.
            scenes.push(serde_json::json!({"id":scene_id, "name":name, "isMain":is_main, "createdAt":now, "updatedAt":now, "bookmarks":[],
                "tracks":{"overlay":[], "audio":[], "order":[main_track_id], "main":{"id":main_track_id, "name":"Main Track", "type":"video", "elements":[], "muted":false, "hidden":false}}}));
            Ok(scene_id)
        }
        SceneChange::Rename { scene_id, name } => {
            valid_text(&name, 1024, "scene name")?;
            let scene = scenes
                .iter_mut()
                .find(|scene| scene["id"] == scene_id)
                .ok_or_else(|| CapabilityError::InvalidInput("Classic scene not found".into()))?;
            scene["name"] = Value::String(name);
            scene["updatedAt"] = Value::String(now.into());
            Ok(scene_id)
        }
        SceneChange::Select { scene_id } => {
            if !scenes.iter().any(|scene| scene["id"] == scene_id) {
                return Err(CapabilityError::InvalidInput(
                    "Classic scene not found".into(),
                ));
            }
            classic
                .document
                .insert("currentSceneId".into(), Value::String(scene_id.clone()));
            Ok(scene_id)
        }
    }
}
