//! Canonical Classic clip creation and batch placement.
use super::classic_track_layout::{ClassicTrackType, LayoutChange, apply_layout};
use super::*;
use crate::{AnimationTargetSelector, ClassicAnimationCatalog};
use serde_json::json;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Video,
    Image,
    Audio,
    Text,
    Sticker,
    Graphic,
    Effect,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Draft {
    #[serde(rename = "type")]
    kind: Kind,
    name: String,
    start_time: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    trim_start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    trim_end: Option<i64>,
    #[serde(default)]
    params: Map<String, Value>,
    /// Forward-compatible serialized clip fields; binary browser handles are excluded.
    #[serde(flatten)]
    extra: Map<String, Value>,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Placement {
    Explicit {
        track_id: String,
    },
    Auto {
        #[serde(default)]
        track_type: Option<ClassicTrackType>,
        #[serde(default)]
        insert_index: Option<i64>,
    },
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Clip {
    element: Draft,
    placement: Placement,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[serde(default)]
    catalog_revision: Option<String>,
    #[schemars(length(min = 1, max = 1000))]
    clips: Vec<Clip>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Ref {
    track_id: String,
    element_id: String,
}
#[derive(Serialize, JsonSchema)]
struct Output {
    #[serde(flatten)]
    mutation: MutationOutput,
    elements: Vec<Ref>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogInput {
    project_id: String,
    expected_revision: u64,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CatalogOutput {
    revision: u64,
    catalog_revision: String,
    graphics: Vec<Value>,
    default_duration: i64,
}

pub(super) fn register_classic_insert(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    catalog: ClassicAnimationCatalog,
) -> Result<(), RegistryError> {
    let read_state = state.clone();
    let read_catalog = catalog.clone();
    register::<CatalogInput, CatalogOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.elements.catalog",
        "Read Classic clip creation definitions",
        "Reads live registered graphic definition IDs and product parameter metadata for creating Classic clips, including an empty scene. Does not mutate state. Supply the active project and expectedRevision; pass catalogRevision to insertion when creating graphics. Default duration is five seconds in 120000 ticks per second. Video/image/upload audio reference existing project media; library audio and stickers keep their own identifiers. This catalog is host-published product metadata, not an agent-specific list.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["classic", "insert", "create", "graphic", "catalog"],
        move |_, input| {
            let state = read_state.clone();
            let catalog = read_catalog.clone();
            async move {
                let store = state.read().map_err(|_| invalid("state lock poisoned"))?;
                if store.active_project_id() != Some(input.project_id.as_str())
                    || store.document.revision != input.expected_revision
                {
                    return Err(CapabilityError::Conflict(
                        "creation catalog project or revision changed".into(),
                    ));
                }
                let catalog = catalog
                    .0
                    .read()
                    .map_err(|_| invalid("catalog lock poisoned"))?;
                let graphics = catalog
                    .groups
                    .iter()
                    .filter_map(|group| match &group.target {
                        AnimationTargetSelector::Element {
                            element_type,
                            definition_id: Some(id),
                            path_prefix,
                            ..
                        } if element_type == "graphic" && path_prefix == "params." => {
                            Some(json!({"definitionId":id,"params":group.params}))
                        }
                        _ => None,
                    })
                    .collect();
                Ok(OperationSuccess::new(CatalogOutput {
                    revision: store.document.revision,
                    catalog_revision: catalog.revision.clone(),
                    graphics,
                    default_duration: 600000,
                }))
            }
        },
    )?;
    register::<Input, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.elements.insert",
        "Insert Classic clips",
        "Atomically insert 1..1000 video, image, audio, text, sticker, graphic or effect drafts in one explicit Classic scene. Each clip supplies element and placement. Timing uses nonnegative exact integer ticks at 120000/second; omitted duration defaults to five seconds and trims to zero. Runtime allocates fresh identities and preserves serialized extension fields; do not supply id or browser buffer/file handles. Explicit placement requires a compatible track and allows overlaps. Auto chooses the first non-overlapping compatible track in display order, otherwise creates one at the top (insertIndex only overrides new-track placement). Video/image go on video tracks, text on text, audio on audio, sticker/graphic on graphic, effect on effect. Main-track first/earliest inserts anchor at zero. Graphics require a current catalogRevision and registered definitionId from timeline.classic.elements.catalog. Media clips must reference existing compatible project media, including offline records; no media is uploaded/decoded/copied. The first visual media clip in an empty scene adopts known canvas dimensions/original dimensions and video FPS. Text ownership is reconciled with retained caption sources. Returns created track/clip references. Supports dry run, exact retries, revision checks, cancellation, transactional rollback and Undo/Redo for the whole batch.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic",
            "insert",
            "add",
            "clip",
            "text",
            "video",
            "audio",
            "graphic",
            "הוספה",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            let catalog = catalog.clone();
            async move {
                let catalog = catalog
                    .0
                    .read()
                    .map_err(|_| invalid("catalog lock poisoned"))?
                    .clone();
                let mut elements = Vec::new();
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Insert timeline clips",
                    Some(input.expected_revision),
                    |document| {
                        let mut occupied = HashSet::new();
                        collect_ids(
                            &serde_json::to_value(&document.project)
                                .map_err(|e| invalid(&e.to_string()))?,
                            &mut occupied,
                        );
                        for clip in &input.clips {
                            collect_ids(
                                &serde_json::to_value(&clip.element)
                                    .map_err(|e| invalid(&e.to_string()))?,
                                &mut occupied,
                            );
                        }
                        for clip in &input.clips {
                            if context.cancellation.is_cancelled() {
                                return Err(CapabilityError::Failed(
                                    "operation was cancelled".into(),
                                ));
                            }
                            let mut element = serde_json::to_value(&clip.element)
                                .map_err(|e| invalid(&e.to_string()))?;
                            if ["id", "buffer", "file"]
                                .iter()
                                .any(|key| element.get(key).is_some())
                            {
                                return Err(invalid(
                                    "identity and browser handles are not clip drafts",
                                ));
                            }
                            element["duration"] = json!(clip.element.duration.unwrap_or(600000));
                            element["trimStart"] = json!(clip.element.trim_start.unwrap_or(0));
                            element["trimEnd"] = json!(clip.element.trim_end.unwrap_or(0));
                            for key in ["startTime", "duration", "trimStart", "trimEnd"] {
                                ticks(&element, key)?;
                            }
                            let project = project_mut(document)?;
                            if project.id != input.project_id {
                                return Err(invalid("Target project is not active"));
                            }
                            let classic = project
                                .classic
                                .as_ref()
                                .ok_or_else(|| invalid("Requires a Classic project"))?;
                            validate_draft(
                                &element,
                                &catalog,
                                input.catalog_revision.as_deref(),
                                &classic.media_assets,
                            )?;
                            let asset = element["mediaId"]
                                .as_str()
                                .and_then(|id| classic.media_assets.iter().find(|a| a["id"] == id))
                                .cloned();
                            let id = fresh(document, &mut occupied, "classic-clip");
                            element["id"] = json!(id);
                            let track_type = track_type(clip.element.kind);
                            let new_track_id = fresh(document, &mut occupied, "classic-track");
                            let project = project_mut(document)?;
                            let classic = project.classic.as_mut().unwrap();
                            let scene = classic.document["scenes"]
                                .as_array_mut()
                                .and_then(|scenes| {
                                    scenes.iter_mut().find(|s| s["id"] == input.scene_id)
                                })
                                .ok_or_else(|| invalid("Scene not found"))?;
                            let empty = all(&scene["tracks"])
                                .all(|t| t["elements"].as_array().is_none_or(Vec::is_empty));
                            let target = place(
                                scene,
                                &clip.placement,
                                track_type,
                                &mut element,
                                &new_track_id,
                            )?;
                            if empty && matches!(clip.element.kind, Kind::Video | Kind::Image) {
                                if let Some(asset) = asset {
                                    adopt_media_settings(&mut classic.document, &asset)?;
                                }
                            }
                            elements.push(Ref {
                                track_id: target,
                                element_id: id,
                            });
                        }
                        let project = project_mut(document)?;
                        let classic = project.classic.as_mut().unwrap();
                        let scene = classic.document["scenes"]
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|s| s["id"] == input.scene_id)
                            .unwrap();
                        super::classic_captions::reconcile_words(&mut scene["tracks"], &[])?;
                        scene["updatedAt"] = json!(super::classic_scenes::timestamp()?);
                        let duration = classic.document["scenes"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|scene| scene["isMain"] == true)
                            .into_iter()
                            .flat_map(|scene| all(&scene["tracks"]))
                            .flat_map(|track| track["elements"].as_array().into_iter().flatten())
                            .filter_map(|element| {
                                element["startTime"]
                                    .as_i64()?
                                    .checked_add(element["duration"].as_i64()?)
                            })
                            .max()
                            .unwrap_or(0);
                        classic.document.get_mut("metadata").unwrap()["duration"] = json!(duration);
                        classic.document.get_mut("metadata").unwrap()["updatedAt"] =
                            json!(super::classic_scenes::timestamp()?);
                        project.settings =
                            classic.settings().map_err(|e| invalid(&e.to_string()))?;
                        Ok(std::iter::once(input.project_id.clone())
                            .chain(std::iter::once(input.scene_id.clone()))
                            .chain(
                                elements
                                    .iter()
                                    .flat_map(|r| [r.track_id.clone(), r.element_id.clone()]),
                            )
                            .collect())
                    },
                )?;
                Ok(OperationSuccess::new(Output { mutation, elements })
                    .summary("Inserted Classic clips")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn ticks(element: &Value, key: &str) -> Result<i64, CapabilityError> {
    element[key]
        .as_i64()
        .filter(|v| (0..=crate::classic::MAX_SAFE_INTEGER).contains(v))
        .ok_or_else(|| invalid("clip timing requires nonnegative safe integer ticks"))
}
fn fresh(document: &mut EditorDocument, occupied: &mut HashSet<String>, prefix: &str) -> String {
    loop {
        let id = document.allocate_id(prefix);
        if occupied.insert(id.clone()) {
            return id;
        }
    }
}
fn all(tracks: &Value) -> impl Iterator<Item = &Value> {
    tracks["overlay"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(std::iter::once(&tracks["main"]))
        .chain(tracks["audio"].as_array().into_iter().flatten())
}
fn track_type(kind: Kind) -> ClassicTrackType {
    match kind {
        Kind::Video | Kind::Image => ClassicTrackType::Video,
        Kind::Audio => ClassicTrackType::Audio,
        Kind::Text => ClassicTrackType::Text,
        Kind::Sticker | Kind::Graphic => ClassicTrackType::Graphic,
        Kind::Effect => ClassicTrackType::Effect,
    }
}
pub(super) fn validate_draft(
    element: &Value,
    catalog: &crate::classic_animation::AnimationCatalogSnapshot,
    revision: Option<&str>,
    media: &[Map<String, Value>],
) -> Result<(), CapabilityError> {
    crate::classic_effects::validate_params(element["params"].as_object().unwrap())?;
    let kind = element["type"].as_str().unwrap();
    let nonempty = |key: &str| element[key].as_str().is_some_and(|v| !v.is_empty());
    if matches!(kind, "video" | "image") || (kind == "audio" && element["sourceType"] == "upload") {
        let asset = media
            .iter()
            .find(|a| a["id"] == element["mediaId"] && nonempty("mediaId"))
            .ok_or_else(|| invalid("Clip requires an existing project media binding"))?;
        let media_type = asset["type"].as_str().unwrap_or("");
        if !(media_type == kind
            || (kind == "audio"
                && media_type == "video"
                && asset.get("hasAudio") != Some(&Value::Bool(false))))
        {
            return Err(invalid("Incompatible media binding"));
        }
    }
    if kind == "audio"
        && !(element["sourceType"] == "upload"
            || (element["sourceType"] == "library"
                && (nonempty("sourceUrl") || nonempty("libraryAssetId"))))
    {
        return Err(invalid("Audio needs uploaded media or a library binding"));
    }
    if kind == "sticker" && !nonempty("stickerId") {
        return Err(invalid("Sticker requires stickerId"));
    }
    if kind == "effect" && !nonempty("effectType") {
        return Err(invalid("Effect requires effectType"));
    }
    if kind == "text"
        && !element["params"]["content"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    {
        return Err(invalid("Text requires content"));
    }
    if kind == "graphic" {
        if revision != Some(catalog.revision.as_str()) || catalog.revision.is_empty() {
            return Err(CapabilityError::Conflict(
                "Graphic creation catalog changed or is unavailable".into(),
            ));
        }
        if !catalog.groups.iter().any(|group|matches!(&group.target,AnimationTargetSelector::Element{element_type,definition_id:Some(id),..} if element_type=="graphic" && element["definitionId"]==*id)){return Err(invalid("Graphic definition is not registered"));}
    }
    Ok(())
}
pub(super) fn place_library_audio(
    scene: &mut Value,
    element: &mut Value,
    new_track_id: &str,
) -> Result<String, CapabilityError> {
    place(scene, &Placement::Auto { track_type: Some(ClassicTrackType::Audio), insert_index: None }, ClassicTrackType::Audio, element, new_track_id)
}

fn place(
    scene: &mut Value,
    placement: &Placement,
    kind: ClassicTrackType,
    element: &mut Value,
    new_id: &str,
) -> Result<String, CapabilityError> {
    let tracks = &scene["tracks"];
    let known: Vec<_> = all(tracks).collect();
    let mut order = Vec::<String>::new();
    for id in tracks["order"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(known.iter().filter_map(|t| t["id"].as_str()))
    {
        if known.iter().any(|t| t["id"] == id) && !order.iter().any(|v| v == id) {
            order.push(id.into());
        }
    }
    let type_value = serde_json::to_value(kind).unwrap();
    let mut target = match placement {
        Placement::Explicit { track_id } => {
            let track = known
                .iter()
                .find(|t| t["id"] == *track_id)
                .ok_or_else(|| invalid("Target track not found"))?;
            if track["type"] != type_value {
                return Err(invalid("Incompatible target track"));
            }
            Some(track_id.clone())
        }
        Placement::Auto { track_type, .. } => {
            if track_type.is_some_and(|t| serde_json::to_value(t).unwrap() != type_value) {
                return Err(invalid("Incompatible requested track type"));
            }
            let start = ticks(element, "startTime")?;
            let end = start
                .checked_add(ticks(element, "duration")?)
                .filter(|v| *v <= crate::classic::MAX_SAFE_INTEGER)
                .ok_or_else(|| invalid("Clip end exceeds safe ticks"))?;
            order
                .iter()
                .find(|id| {
                    known.iter().any(|track| {
                        track["id"] == ***id
                            && track["type"] == type_value
                            && track["elements"].as_array().is_some_and(|items| {
                                items.iter().all(|e| {
                                    start
                                        >= e["startTime"].as_i64().unwrap()
                                            + e["duration"].as_i64().unwrap()
                                        || end <= e["startTime"].as_i64().unwrap()
                                })
                            })
                    })
                })
                .cloned()
        }
    };
    if target.is_none() {
        let index = match placement {
            Placement::Auto { insert_index, .. } => insert_index.unwrap_or(0),
            _ => unreachable!(),
        };
        apply_layout(
            scene,
            LayoutChange::Add {
                track_id: new_id.into(),
                track_type: kind,
                name: None,
                index: Some(index),
            },
        )?;
        target = Some(new_id.into());
    }
    let id = target.unwrap();
    let tracks = &mut scene["tracks"];
    if id != new_id {
        tracks["order"] = json!(order);
    }
    if tracks["main"]["id"] == id {
        let earliest = tracks["main"]["elements"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["startTime"].as_i64())
            .min();
        if earliest.is_none_or(|time| element["startTime"].as_i64().unwrap() <= time) {
            element["startTime"] = json!(0);
        }
    }
    let track = tracks
        .as_object_mut()
        .unwrap()
        .iter_mut()
        .find_map(|(key, value)| {
            if key == "main" && value["id"] == id {
                Some(value)
            } else if matches!(key.as_str(), "overlay" | "audio") {
                value.as_array_mut()?.iter_mut().find(|t| t["id"] == id)
            } else {
                None
            }
        })
        .unwrap();
    if id == new_id {
        track.as_object_mut().unwrap().remove("keepEmpty");
    }
    track["elements"]
        .as_array_mut()
        .unwrap()
        .push(element.clone());
    Ok(id)
}
fn adopt_media_settings(
    document: &mut crate::ClassicDocument,
    asset: &Map<String, Value>,
) -> Result<(), CapabilityError> {
    let mut changed = false;
    let settings = document["settings"].as_object_mut().unwrap();
    if let (Some(width), Some(height)) = (
        asset.get("width").and_then(Value::as_u64),
        asset.get("height").and_then(Value::as_u64),
    ) {
        if width > 0 && height > 0 {
            let size = json!({"width":width,"height":height});
            settings.insert("canvasSize".into(), size.clone());
            if settings
                .get("originalCanvasSize")
                .is_none_or(Value::is_null)
            {
                settings.insert("originalCanvasSize".into(), size);
            }
            changed = true;
        }
    }
    if asset.get("type").and_then(Value::as_str) == Some("video") {
        if let Some(fps) = asset
            .get("fps")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v > 0.0)
        {
            settings.insert("fps".into(), float_rate(fps));
            changed = true;
        }
    }
    if changed {
        document.get_mut("metadata").unwrap()["updatedAt"] =
            json!(super::classic_scenes::timestamp()?);
    }
    Ok(())
}
fn float_rate(fps: f64) -> Value {
    for (n, d) in [
        (24000, 1001),
        (24, 1),
        (25, 1),
        (30000, 1001),
        (30, 1),
        (48, 1),
        (50, 1),
        (60000, 1001),
        (60, 1),
        (120, 1),
    ] {
        if (fps - n as f64 / d as f64).abs() <= 0.01 {
            return json!({"numerator":n,"denominator":d});
        }
    }
    if fps.fract() == 0.0 {
        return json!({"numerator":fps as u64,"denominator":1});
    }
    let n = (fps * 1000000.0 + 0.5).floor() as u64;
    let mut a = n;
    let mut b = 1000000;
    while b != 0 {
        (a, b) = (b, a % b);
    }
    json!({"numerator":n/a.max(1),"denominator":1000000/a.max(1)})
}
