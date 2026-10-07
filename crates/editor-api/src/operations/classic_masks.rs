//! Targeted Classic mask edits. Rendering and pointer hit-testing remain host concerns.
use super::*;
use serde_json::json;

mod geometry;

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Point {
    x: f64,
    y: f64,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Bounds {
    cx: f64,
    cy: f64,
    width: f64,
    height: f64,
    /// Element rotation is retained in the host contract; mask coordinates use their own rotation.
    rotation: f64,
}

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum MaskChange {
    Create {
        #[serde(rename = "maskType")]
        mask_type: String,
        #[serde(default)]
        params: Map<String, Value>,
        #[serde(rename = "elementSize")]
        element_size: Option<Size>,
    },
    Update {
        params: Map<String, Value>,
    },
    Remove,
    ToggleInverted,
    SetInverted {
        inverted: bool,
    },
    DeletePoints {
        #[serde(rename = "pointIds")]
        point_ids: Vec<String>,
    },
    InsertPoint {
        #[serde(rename = "segmentIndex")]
        segment_index: usize,
        #[serde(rename = "canvasPoint")]
        canvas_point: Point,
        bounds: Bounds,
    },
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Size {
    width: f64,
    height: f64,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaskInput {
    project_id: String,
    scene_id: String,
    track_id: String,
    element_id: String,
    mask_id: Option<String>,
    catalog_revision: Option<String>,
    expected_revision: u64,
    change: MaskChange,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct MaskOutput {
    #[serde(flatten)]
    mutation: MutationOutput,
    inserted_point_id: Option<String>,
    removed_point_ids: Vec<String>,
    masks: Vec<Value>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogInput {
    project_id: String,
    query: Option<String>,
    mask_type: Option<String>,
    #[serde(default)]
    include_parameters: bool,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CatalogOutput {
    catalog_revision: String,
    definitions: Vec<Value>,
}

fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}

pub(super) fn register_classic_masks(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    catalog: crate::ClassicMaskCatalog,
) -> Result<(), RegistryError> {
    let read_state = state.clone();
    let read_catalog = catalog.clone();
    register::<CatalogInput, CatalogOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "masks.classic.catalog.read",
        "Read available Classic masks",
        "Read live product mask definitions, default values, sizing policy and parameter descriptions. New product registry definitions appear automatically. query filters type/name; maskType selects an exact type; includeParameters includes defaults and parameter definitions. Use catalogRevision for create/update. Default sizing uses optional rendered elementSize in canvas pixels; missing size uses product fallback defaults. Freeform defaults are empty and invisible until a path is drawn.",
        "masks",
        AccessLevel::Read,
        false,
        false,
        &["classic", "mask", "catalog", "parameters", "shape"],
        move |_, input| {
            let state = read_state.clone();
            let catalog = read_catalog.clone();
            async move {
                if state
                    .read()
                    .map_err(|_| invalid("state lock poisoned"))?
                    .active_project_id()
                    != Some(input.project_id.as_str())
                {
                    return Err(CapabilityError::Conflict(
                        "mask catalog project is not active".into(),
                    ));
                }
                let catalog = catalog
                    .0
                    .read()
                    .map_err(|_| invalid("mask catalog lock poisoned"))?;
                let query = input.query.unwrap_or_default().to_lowercase();
                let definitions = catalog
                    .definitions
                    .iter()
                    .filter(|d| input.mask_type.as_ref().is_none_or(|t| d["type"] == *t))
                    .filter(|d| {
                        query.is_empty()
                            || json!([d["type"], d["name"]])
                                .to_string()
                                .to_lowercase()
                                .contains(&query)
                    })
                    .map(|d| {
                        let mut d = d.clone();
                        if !input.include_parameters {
                            d.as_object_mut().unwrap().remove("params");
                            d.as_object_mut().unwrap().remove("defaults");
                        }
                        d
                    })
                    .collect();
                Ok(OperationSuccess::new(CatalogOutput {
                    catalog_revision: catalog.revision.clone(),
                    definitions,
                }))
            }
        },
    )?;
    register::<MaskInput, MaskOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.masks.edit",
        "Edit Classic clip masks",
        "Create a product mask, update its declared parameters, remove it, set/toggle inversion, delete freeform points or insert a point on a segment. Read masks.classic.catalog.read before create/update and supply catalogRevision. Create omits maskId, rejects a clip that already has masks (current product supports one), allocates IDs and uses product defaults plus optional params/elementSize. Update merges only supplied parameters. Read target IDs from app.state.read at /project/classic/document/scenes. Only video/image/graphic clips support masks. Insert uses canvasPoint and rendered bounds in pixels, projects onto the segment and recenters. Closed paths include the final-to-first segment. Deleting points opens paths with fewer than three anchors. Preserves other masks, media, timing and unknown fields. Explicit project/scene/track/clip/revision required; existing-mask operations also require maskId. Supports dry run (returns predicted masks without mutation), exact retries, cancellation, atomic transactions and Undo/Redo.",
        "masks",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic", "mask", "freeform", "point", "path", "invert", "remove",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            let catalog = catalog.clone();
            async move {
                let catalog = catalog
                    .0
                    .read()
                    .map_err(|_| invalid("mask catalog lock poisoned"))?;
                if matches!(
                    input.change,
                    MaskChange::Create { .. } | MaskChange::Update { .. }
                ) && input.catalog_revision.as_deref() != Some(catalog.revision.as_str())
                {
                    return Err(CapabilityError::Conflict(
                        "mask catalog changed or missing; read it before editing".into(),
                    ));
                }
                let mut inserted_point_id = None;
                let mut removed_point_ids = Vec::new();
                let mut resulting_masks = Vec::new();
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Edit clip mask",
                    Some(input.expected_revision),
                    |document| {
                        // Allocate only for insertion; document transactions roll this back on invalid input/dry run.
                        let point_id = if matches!(
                            input.change,
                            MaskChange::InsertPoint { .. } | MaskChange::Create { .. }
                        ) {
                            let serialized = serde_json::to_value(&document.project)
                                .map_err(|e| invalid(&e.to_string()))?;
                            let mut ids = HashSet::new();
                            collect_ids(&serialized, &mut ids);
                            Some(loop {
                                let id = document.allocate_id(
                                    if matches!(input.change, MaskChange::Create { .. }) {
                                        "classic-mask"
                                    } else {
                                        "classic-mask-point"
                                    },
                                );
                                if !ids.contains(&id) {
                                    break id;
                                }
                            })
                        } else {
                            None
                        };
                        let element = element_mut(document, &input)?;
                        if let MaskChange::Create {
                            mask_type,
                            params,
                            element_size,
                        } = &input.change
                        {
                            if input.mask_id.is_some() {
                                return Err(invalid("create allocates maskId; omit it"));
                            }
                            if element.get("masks").is_some_and(|v| {
                                !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty())
                            }) {
                                return Err(CapabilityError::Conflict(
                                    "remove the existing mask before creating another".into(),
                                ));
                            }
                            let mut mask = crate::classic_masks::build(
                                &catalog,
                                mask_type,
                                element_size.as_ref().map(|s| (s.width, s.height)),
                                params,
                            )?;
                            mask["id"] = json!(point_id.as_ref().unwrap());
                            validate_freeform(&mask)?;
                            resulting_masks = vec![mask];
                            element["masks"] = json!(resulting_masks);
                            return Ok(vec![
                                input.project_id.clone(),
                                input.scene_id.clone(),
                                input.track_id.clone(),
                                input.element_id.clone(),
                            ]);
                        }
                        let mask_id = input
                            .mask_id
                            .as_ref()
                            .filter(|id| !id.is_empty())
                            .ok_or_else(|| invalid("existing mask edit requires maskId"))?;
                        let masks = element
                            .get_mut("masks")
                            .and_then(Value::as_array_mut)
                            .ok_or_else(|| invalid("target clip has no masks"))?;
                        let matches: Vec<_> = masks
                            .iter()
                            .enumerate()
                            .filter(|(_, m)| m["id"] == *mask_id)
                            .map(|(i, _)| i)
                            .collect();
                        if matches.len() != 1 {
                            return Err(invalid(
                                "mask ID must identify exactly one mask on the target clip",
                            ));
                        }
                        let index = matches[0];
                        match &input.change {
                            MaskChange::Remove => {
                                masks.remove(index);
                            }
                            change => {
                                let mask = &mut masks[index];
                                let kind = mask["type"].as_str().unwrap_or("").to_owned();
                                if matches!(
                                    change,
                                    MaskChange::DeletePoints { .. }
                                        | MaskChange::InsertPoint { .. }
                                ) && mask["type"] != "freeform"
                                {
                                    return Err(invalid("point edits require a freeform mask"));
                                }
                                let params = mask
                                    .get_mut("params")
                                    .and_then(Value::as_object_mut)
                                    .ok_or_else(|| invalid("mask has no parameter object"))?;
                                match change {
                                    MaskChange::Update { params: updates } => {
                                        let definition =
                                            crate::classic_masks::definition(&catalog, &kind)?;
                                        crate::classic_masks::validate_update(definition, updates)?;
                                        params.extend(updates.clone());
                                        validate_freeform(mask)?;
                                    }
                                    MaskChange::SetInverted { inverted } => {
                                        params.insert("inverted".into(), json!(inverted));
                                    }
                                    MaskChange::ToggleInverted => {
                                        if params
                                            .get("inverted")
                                            .is_some_and(|v| !v.is_null() && !v.is_boolean())
                                        {
                                            return Err(invalid("mask inversion must be boolean"));
                                        }
                                        params.insert(
                                            "inverted".into(),
                                            json!(
                                                params.get("inverted") != Some(&Value::Bool(true))
                                            ),
                                        );
                                    }
                                    MaskChange::DeletePoints { point_ids } => {
                                        if point_ids.len() > 10000
                                            || point_ids.iter().any(|id| id.is_empty())
                                        {
                                            return Err(invalid("invalid point ID list"));
                                        }
                                        let closed = params
                                            .get("closed")
                                            .and_then(Value::as_bool)
                                            .ok_or_else(|| {
                                                invalid("freeform closed flag must be boolean")
                                            })?;
                                        let points = params
                                            .get_mut("path")
                                            .and_then(Value::as_array_mut)
                                            .ok_or_else(|| {
                                                invalid("freeform path must be an array")
                                            })?;
                                        geometry::validate_points(points)?;
                                        let requested: HashSet<_> = point_ids.iter().collect();
                                        points.retain(|p| {
                                            let id = p["id"].as_str().unwrap();
                                            if requested.contains(&id.to_owned()) {
                                                removed_point_ids.push(id.into());
                                                false
                                            } else {
                                                true
                                            }
                                        });
                                        if !removed_point_ids.is_empty() {
                                            let remains_closed = closed && points.len() >= 3;
                                            params.insert("closed".into(), json!(remains_closed));
                                        }
                                    }
                                    MaskChange::InsertPoint {
                                        segment_index,
                                        canvas_point,
                                        bounds,
                                    } => {
                                        let id = point_id.as_ref().unwrap();
                                        geometry::insert(
                                            params,
                                            *segment_index,
                                            *canvas_point,
                                            bounds,
                                            id,
                                        )?;
                                        inserted_point_id = Some(id.clone());
                                    }
                                    MaskChange::Remove | MaskChange::Create { .. } => {
                                        unreachable!()
                                    }
                                }
                            }
                        }
                        resulting_masks = masks.clone();
                        Ok(vec![
                            input.project_id.clone(),
                            input.scene_id.clone(),
                            input.track_id.clone(),
                            input.element_id.clone(),
                        ])
                    },
                )?;
                Ok(OperationSuccess::new(MaskOutput {
                    mutation,
                    inserted_point_id,
                    removed_point_ids,
                    masks: resulting_masks,
                })
                .summary("Edited Classic mask")
                .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

fn validate_freeform(mask: &Value) -> Result<(), CapabilityError> {
    if mask["type"] == "freeform" {
        let params = &mask["params"];
        let points = params["path"]
            .as_array()
            .ok_or_else(|| invalid("freeform path must be an array"))?;
        geometry::validate_points(points)?;
        let closed = params["closed"]
            .as_bool()
            .ok_or_else(|| invalid("freeform closed flag must be boolean"))?;
        if closed && points.len() < 3 {
            return Err(invalid(
                "closing a freeform mask requires at least three points",
            ));
        }
        for key in ["centerX", "centerY", "rotation", "scale"] {
            if !params[key].as_f64().is_some_and(f64::is_finite) {
                return Err(invalid("freeform transform must be finite"));
            }
        }
        if params["scale"].as_f64() == Some(0.0) {
            return Err(invalid("freeform scale cannot be zero"));
        }
    }
    Ok(())
}


fn element_mut<'a>(
    document: &'a mut EditorDocument,
    input: &MaskInput,
) -> Result<&'a mut Value, CapabilityError> {
    let project = project_mut(document)?;
    if project.id != input.project_id {
        return Err(CapabilityError::Conflict(
            "mask target project is not active".into(),
        ));
    }
    let classic = project.classic.as_mut().ok_or_else(|| {
        CapabilityError::Unavailable("mask edits require a Classic project".into())
    })?;
    let scene = classic.document["scenes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == input.scene_id)
        .ok_or_else(|| invalid("mask target scene not found"))?;
    let track = scene["tracks"]
        .as_object_mut()
        .unwrap()
        .iter_mut()
        .find_map(|(key, v)| {
            if key == "main" && v["id"] == input.track_id {
                Some(v)
            } else if key == "overlay" || key == "audio" {
                v.as_array_mut()?
                    .iter_mut()
                    .find(|t| t["id"] == input.track_id)
            } else {
                None
            }
        })
        .ok_or_else(|| invalid("mask target track not found"))?;
    let element = track["elements"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["id"] == input.element_id)
        .ok_or_else(|| invalid("mask target clip not found"))?;
    if !matches!(
        element["type"].as_str(),
        Some("video" | "image" | "graphic")
    ) {
        return Err(invalid("masks require a video, image or graphic clip"));
    }
    Ok(element)
}
