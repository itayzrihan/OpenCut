//! Scoped clip snapshots and atomic Classic clipboard placement.
use super::classic_track_layout::{ClassicTrackType, LayoutChange, apply_layout};
use super::*;
use serde_json::json;

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ElementRef {
    track_id: String,
    element_id: String,
}
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Item {
    track_id: String,
    track_type: ClassicTrackType,
    element: Map<String, Value>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CopyInput {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 1000))]
    elements: Vec<ElementRef>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CopyOutput {
    source_project_id: String,
    revision: u64,
    items: Vec<Item>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PasteInput {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    source_project_id: String,
    time: i64,
    #[schemars(length(min = 1, max = 1000))]
    items: Vec<Item>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PasteOutput {
    #[serde(flatten)]
    mutation: MutationOutput,
    elements: Vec<ElementRef>,
}

pub(super) fn register_classic_clipboard(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
    catalog: crate::ClassicAnimationCatalog,
) -> Result<(), RegistryError> {
    let copy_state = state.clone();
    register::<CopyInput, CopyOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "clipboard.classic.elements.copy",
        "Read a scoped Classic clip clipboard snapshot",
        "Read 1..1000 explicit clip references from one active Classic project/scene/revision. Returns sourceProjectId and serializable items with source trackId/type and clip fields, omitting clip identity and browser file/buffer handles. Preserves timing, trim, retime, words, transitions, effects and animations. Does not edit the document or a hidden global clipboard. The snapshot is bounded to one MiB and can be supplied to timeline.classic.elements.paste. Copying between projects with media requires an explicit owned media-transfer operation; this snapshot does not grant access to another project's files.",
        "clipboard",
        AccessLevel::Read,
        true,
        false,
        &["classic", "copy", "clipboard", "clip", "העתקה"],
        move |context, input| {
            let state = copy_state.clone();
            async move {
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                let store = state.read().map_err(|_| invalid("state lock poisoned"))?;
                if store.document.revision != input.expected_revision {
                    return Err(CapabilityError::Conflict(
                        "Clipboard revision changed".into(),
                    ));
                }
                let scene = scene(&store.document, &input.project_id, &input.scene_id)?;
                let mut seen = HashSet::new();
                let mut items = Vec::new();
                for target in &input.elements {
                    if !seen.insert((&target.track_id, &target.element_id)) {
                        return Err(invalid("Duplicate clipboard reference"));
                    }
                    let track = all(&scene["tracks"])
                        .find(|t| t["id"] == target.track_id)
                        .ok_or_else(|| invalid("Clipboard track not found"))?;
                    let mut element = track["elements"]
                        .as_array()
                        .and_then(|v| v.iter().find(|e| e["id"] == target.element_id))
                        .and_then(Value::as_object)
                        .ok_or_else(|| invalid("Clipboard clip not found"))?
                        .clone();
                    for key in ["id", "file", "buffer"] {
                        element.remove(key);
                    }
                    let track_type = serde_json::from_value(track["type"].clone())
                        .map_err(|_| invalid("Invalid clipboard track type"))?;
                    items.push(Item {
                        track_id: target.track_id.clone(),
                        track_type,
                        element,
                    });
                }
                bounded(&items)?;
                Ok(OperationSuccess::new(CopyOutput {
                    source_project_id: input.project_id,
                    revision: store.document.revision,
                    items,
                }))
            }
        },
    )?;
    register::<PasteInput, PasteOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.elements.paste",
        "Paste scoped Classic clip snapshots",
        "Atomically paste 1..1000 clipboard items at a nonnegative exact tick time (120000 ticks/second). sourceProjectId must match the active target project; cross-project media transfer is separate. Preserves relative offsets from the earliest copied start, groups items by source track, and chooses a compatible non-overlapping track immediately above that source, then the first available compatible track, otherwise creates a track at the top. Source tracks may have been removed since copying. A group's earliest main-track clip anchors at zero, preserving offsets within the group. Runtime assigns fresh clip/keyframe identities, preserves other serialized clip fields and validates current owned media and graphic definitions. Snapshot at most one MiB, no supplied clip id/file/buffer. Read targets back via app.state.read. One undo entry, revision checks, exact retry keys, cancellation, dry run and transactional rollback.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["classic", "paste", "clipboard", "clip", "הדבקה"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            let catalog = catalog.clone();
            async move {
                let mut elements = Vec::new();
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Paste timeline clips",
                    Some(input.expected_revision),
                    |document| {
                        elements = paste(document, &input, &context, &catalog)?;
                        Ok(std::iter::once(input.project_id.clone())
                            .chain(
                                elements
                                    .iter()
                                    .flat_map(|v| [v.track_id.clone(), v.element_id.clone()]),
                            )
                            .collect())
                    },
                )?;
                Ok(
                    OperationSuccess::new(PasteOutput { mutation, elements }).changed([
                        STATE_RESOURCE,
                        PROJECT_RESOURCE,
                        TIMELINE_RESOURCE,
                    ]),
                )
            }
        },
    )
}
fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn bounded(items: &[Item]) -> Result<(), CapabilityError> {
    if serde_json::to_vec(items)
        .map_err(|e| invalid(&e.to_string()))?
        .len()
        > 1024 * 1024
    {
        return Err(invalid("Clipboard snapshot exceeds one MiB"));
    }
    Ok(())
}
fn scene<'a>(
    document: &'a EditorDocument,
    project_id: &str,
    scene_id: &str,
) -> Result<&'a Value, CapabilityError> {
    let project = document
        .project
        .as_ref()
        .ok_or_else(|| invalid("No active project"))?;
    if project.id != project_id {
        return Err(CapabilityError::Conflict(
            "Clipboard target project is not active".into(),
        ));
    }
    project
        .classic
        .as_ref()
        .ok_or_else(|| invalid("Requires a Classic project"))?
        .document["scenes"]
        .as_array()
        .and_then(|v| v.iter().find(|s| s["id"] == scene_id))
        .ok_or_else(|| invalid("Scene not found"))
}
fn all(tracks: &Value) -> impl Iterator<Item = &Value> {
    tracks["overlay"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(std::iter::once(&tracks["main"]))
        .chain(tracks["audio"].as_array().into_iter().flatten())
}
fn order(tracks: &Value) -> Vec<String> {
    let known: Vec<_> = all(tracks).collect();
    let mut order: Vec<String> = Vec::new();
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
    order
}
fn track_mut<'a>(tracks: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    for (key, value) in tracks.as_object_mut()? {
        if key == "main" && value["id"] == id {
            return Some(value);
        }
        if matches!(key.as_str(), "overlay" | "audio") {
            if let Some(track) = value
                .as_array_mut()
                .and_then(|v| v.iter_mut().find(|t| t["id"] == id))
            {
                return Some(track);
            }
        }
    }
    None
}
fn ticks(element: &Value, key: &str) -> Result<i64, CapabilityError> {
    element[key]
        .as_i64()
        .filter(|v| (0..=crate::classic::MAX_SAFE_INTEGER).contains(v))
        .ok_or_else(|| invalid("Clipboard timing requires safe nonnegative integer ticks"))
}
fn paste(
    document: &mut EditorDocument,
    input: &PasteInput,
    context: &InvocationContext,
    catalog: &crate::ClassicAnimationCatalog,
) -> Result<Vec<ElementRef>, CapabilityError> {
    if input.source_project_id != input.project_id {
        return Err(invalid(
            "Cross-project clipboard requires explicit media transfer",
        ));
    }
    if !(0..=crate::classic::MAX_SAFE_INTEGER).contains(&input.time) {
        return Err(invalid("Paste time requires safe nonnegative ticks"));
    }
    bounded(&input.items)?;
    let before = scene(document, &input.project_id, &input.scene_id)?.clone();
    let media = document
        .project
        .as_ref()
        .unwrap()
        .classic
        .as_ref()
        .unwrap()
        .media_assets
        .clone();
    let definitions = catalog
        .0
        .read()
        .map_err(|_| invalid("catalog lock poisoned"))?
        .clone();
    let mut minimum = i64::MAX;
    for item in &input.items {
        let element = Value::Object(item.element.clone());
        if ["id", "buffer", "file"]
            .iter()
            .any(|k| item.element.contains_key(*k))
            || !element["params"].is_object()
        {
            return Err(invalid("Invalid clipboard draft or browser handles"));
        }
        let compatible = match element["type"].as_str() {
            Some("video" | "image") => "video",
            Some("text") => "text",
            Some("audio") => "audio",
            Some("sticker" | "graphic") => "graphic",
            Some("effect") => "effect",
            _ => return Err(invalid("Unsupported clipboard clip type")),
        };
        if serde_json::to_value(item.track_type).unwrap() != compatible {
            return Err(invalid("Clipboard track type is incompatible"));
        }
        for key in ["startTime", "duration", "trimStart", "trimEnd"] {
            ticks(&element, key)?;
        }
        classic_insert::validate_draft(
            &element,
            &definitions,
            Some(&definitions.revision),
            &media,
        )?;
        minimum = minimum.min(ticks(&element, "startTime")?);
    }
    let mut groups: Vec<(String, ClassicTrackType, Vec<Value>)> = Vec::new();
    let mut occupied = HashSet::new();
    collect_ids(
        &serde_json::to_value(&document.project).unwrap(),
        &mut occupied,
    );
    for item in &input.items {
        if context.cancellation.is_cancelled() {
            return Err(CapabilityError::Failed("operation was cancelled".into()));
        }
        let mut copy = Value::Object(item.element.clone());
        let start = input
            .time
            .checked_add(ticks(&copy, "startTime")? - minimum)
            .filter(|v| *v <= crate::classic::MAX_SAFE_INTEGER)
            .ok_or_else(|| invalid("Pasted start exceeds safe ticks"))?;
        start
            .checked_add(ticks(&copy, "duration")?)
            .filter(|v| *v <= crate::classic::MAX_SAFE_INTEGER)
            .ok_or_else(|| invalid("Pasted end exceeds safe ticks"))?;
        copy["startTime"] = json!(start);
        copy["id"] = json!(classic_duplicate::fresh(
            document,
            &mut occupied,
            "classic-clip"
        ));
        classic_duplicate::clone_animation(document, &mut occupied, &mut copy)?;
        if let Some(group) = groups.iter_mut().find(|g| g.0 == item.track_id) {
            if serde_json::to_value(group.1).unwrap()
                != serde_json::to_value(item.track_type).unwrap()
            {
                return Err(invalid("Clipboard source group has mixed track types"));
            }
            group.2.push(copy);
        } else {
            groups.push((item.track_id.clone(), item.track_type, vec![copy]));
        }
    }
    let mut changed = before;
    let mut output = Vec::new();
    for (source, kind, mut copies) in groups {
        let tracks = &changed["tracks"];
        let order = order(tracks);
        let kind_value = serde_json::to_value(kind).unwrap();
        let available = |id: &str| {
            all(tracks)
                .find(|t| t["id"] == id && t["type"] == kind_value)
                .filter(|t| {
                    t["elements"].as_array().is_some_and(|v| {
                        copies.iter().all(|copy| {
                            let start = copy["startTime"].as_i64().unwrap();
                            let end = start + copy["duration"].as_i64().unwrap();
                            v.iter().all(|e| {
                                start
                                    >= e["startTime"].as_i64().unwrap()
                                        + e["duration"].as_i64().unwrap()
                                    || end <= e["startTime"].as_i64().unwrap()
                            })
                        })
                    })
                })
                .map(|_| id.to_owned())
        };
        let target = order
            .iter()
            .position(|id| id == &source)
            .and_then(|i| i.checked_sub(1))
            .and_then(|i| available(&order[i]))
            .or_else(|| order.iter().find_map(|id| available(id)));
        let target = if let Some(target) = target {
            target
        } else {
            let id = classic_duplicate::fresh(document, &mut occupied, "classic-track");
            apply_layout(
                &mut changed,
                LayoutChange::Add {
                    track_id: id.clone(),
                    track_type: kind,
                    name: None,
                    index: Some(0),
                },
            )?;
            id
        };
        if changed["tracks"]["main"]["id"] == target {
            let earliest = copies
                .iter()
                .filter_map(|e| e["startTime"].as_i64())
                .min()
                .unwrap();
            let current = changed["tracks"]["main"]["elements"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|e| e["startTime"].as_i64())
                .min();
            if current.is_none_or(|v| earliest <= v) {
                for copy in &mut copies {
                    copy["startTime"] = json!(copy["startTime"].as_i64().unwrap() - earliest);
                }
            }
        }
        output.extend(copies.iter().map(|e| ElementRef {
            track_id: target.clone(),
            element_id: e["id"].as_str().unwrap().into(),
        }));
        let track = track_mut(&mut changed["tracks"], &target).unwrap();
        track.as_object_mut().unwrap().remove("keepEmpty");
        track["elements"].as_array_mut().unwrap().extend(copies);
    }
    classic_captions::reconcile_words(&mut changed["tracks"], &[])?;
    *project_mut(document)?.classic.as_mut().unwrap().document["scenes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == input.scene_id)
        .unwrap() = changed;
    Ok(output)
}
