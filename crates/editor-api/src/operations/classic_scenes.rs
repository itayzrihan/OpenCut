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
