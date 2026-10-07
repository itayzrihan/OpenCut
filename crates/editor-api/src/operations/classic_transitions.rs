//! Semantic in/out transitions; the same immutable definitions feed UI and MCP.
use super::*;
use serde_json::json;
use std::sync::OnceLock;
const CONTROLLED: [&str; 12] = [
    "opacity",
    "transform.positionX",
    "transform.positionY",
    "transform.scaleX",
    "transform.scaleY",
    "transform.rotate",
    "transition.shatter",
    "background.paddingX",
    "background.paddingY",
    "background.offsetX",
    "background.offsetY",
    "background.cornerRadius",
];
fn catalog() -> &'static Vec<Value> {
    static CATALOG: OnceLock<Vec<Value>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../classic/rust/crates/timeline/data/transition-presets.json"
        ))
        .expect("checked transition definitions")
    })
}
fn preset(id: &str) -> Result<&'static Value, CapabilityError> {
    catalog()
        .iter()
        .find(|p| p["id"] == id)
        .ok_or_else(|| invalid("Unknown transition preset; read the live catalog"))
}
fn text_sfx_catalog() -> &'static Vec<Value> {
    static CATALOG: OnceLock<Vec<Value>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../classic/rust/crates/timeline/data/text-transition-sfx-presets.json"
        ))
        .expect("checked text SFX feature definitions")
    })
}
const SFX_KIND: &str = "opencut.textTransitionSfx.kind";
const SFX_TEXT: &str = "opencut.textTransitionSfx.textElementId";
const SFX_PRESET: &str = "opencut.textTransitionSfx.presetId";
fn companion(source: &Value, app: &Application) -> Result<Option<Value>, CapabilityError> {
    if source["type"] != "text" {
        return Ok(None);
    }
    let Some(p) = text_sfx_catalog()
        .iter()
        .find(|p| p["transitionId"] == app.preset_id && p["side"] == app.side.key())
    else {
        return Ok(None);
    };
    let seconds = |key: &str| {
        ((p[key].as_f64().expect("checked SFX timing") * 120000.0) + 0.5).floor() as i64
    };
    // Preserve authored companion anchoring: it uses the requested percentage,
    // independently of the visual flicker preset's minimum duration.
    let span = ((ticks(&source["duration"])? as f64 * app.percent.unwrap_or(5.0).clamp(0.0, 100.0)
        / 100.0)
        .min(360000.0)
        + 0.5)
        .floor() as i64;
    let start = ticks(&source["startTime"])?
        + if matches!(app.side, Side::Out) {
            ticks(&source["duration"])? - span
        } else {
            0
        };
    Ok(Some(
        json!({"type":"audio","sourceType":"library","librarySourceType":"shared","libraryAssetId":p["assetId"],"name":p["name"],"startTime":(start-seconds("leadInSeconds")).max(0),"duration":seconds("durationSeconds"),"sourceDuration":seconds("sourceDurationSeconds"),"trimStart":seconds("trimStartSeconds"),"trimEnd":seconds("trimEndSeconds"),"params":{"audioSyncOffset":0,"volume":p["volume"],"muted":false,"fadeInDuration":0,"fadeOutDuration":0,SFX_KIND:"text-transition-in-sfx",SFX_TEXT:app.element_id,SFX_PRESET:app.preset_id}}),
    ))
}
fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn properties(preset: &Value) -> HashSet<&str> {
    CONTROLLED
        .into_iter()
        .filter(|p| !preset["state"][p].is_null() || !preset["recipe"][p].is_null())
        .collect()
}
fn ticks(v: &Value) -> Result<i64, CapabilityError> {
    v.as_i64()
        .filter(|n| (0..=9_007_199_254_740_991).contains(n))
        .ok_or_else(|| invalid("Transition timing must be safe nonnegative integer ticks"))
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Side {
    In,
    Out,
}
impl Side {
    fn key(&self) -> &str {
        match self {
            Self::In => "in",
            Self::Out => "out",
        }
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Application {
    track_id: String,
    element_id: String,
    preset_id: String,
    side: Side,
    percent: Option<f64>,
    #[schemars(range(min = 0, max = 9007199254740991_i64))]
    duration: Option<i64>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 1000))]
    applications: Vec<Application>,
    #[serde(default)]
    managed_text_sfx: bool,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogInput {
    query: Option<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_limit")]
    #[schemars(range(min = 1, max = 50))]
    limit: usize,
}
fn default_limit() -> usize {
    20
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CatalogOutput {
    total: usize,
    presets: Vec<Value>,
    has_more: bool,
    text_sfx_presets: Vec<Value>,
}
fn all(tracks: &Value) -> impl Iterator<Item = &Value> {
    std::iter::once(&tracks["main"])
        .chain(tracks["overlay"].as_array().into_iter().flatten())
        .chain(tracks["audio"].as_array().into_iter().flatten())
}
fn track_mut<'a>(tracks: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    if tracks["main"]["id"] == id {
        return tracks.get_mut("main");
    }
    tracks
        .as_object_mut()?
        .iter_mut()
        .filter(|(k, _)| matches!(k.as_str(), "overlay" | "audio"))
        .flat_map(|(_, v)| v.as_array_mut().into_iter().flatten())
        .find(|t| t["id"] == id)
}
fn timestamp() -> String {
    #[cfg(target_arch = "wasm32")]
    let millis = js_sys::Date::now() as i64;
    #[cfg(not(target_arch = "wasm32"))]
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    chrono::DateTime::from_timestamp_millis(millis)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub(super) fn register_classic_transitions(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<CatalogInput, CatalogOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.transitions.catalog",
        "Discover transition presets",
        "Read the shared immutable transition feature catalog used by the UI, including exact preset IDs, labels, keywords, states and recipes. Optional query matches id/label/keywords; offset/limit paginate (default 20, max 50). Definitions added to the feature catalog are automatically available here and in the apply contract without agent or MCP tool wiring. This is metadata, not rendered evidence.",
        "timeline",
        AccessLevel::Read,
        false,
        false,
        &["classic", "transition", "catalog", "preset", "מעבר"],
        move |_, input| async move {
            if input.query.as_ref().is_some_and(|q| q.len() > 200) {
                return Err(invalid("Catalog query exceeds 200 bytes"));
            }
            let query = input.query.unwrap_or_default().to_lowercase();
            let items: Vec<_> = catalog()
                .iter()
                .filter(|p| {
                    query.is_empty()
                        || format!("{} {} {}", p["id"], p["label"], p["keywords"])
                            .to_lowercase()
                            .contains(&query)
                })
                .collect();
            let total = items.len();
            let presets = items
                .into_iter()
                .skip(input.offset)
                .take(input.limit)
                .cloned()
                .collect::<Vec<_>>();
            let has_more = input.offset.saturating_add(presets.len()) < total;
            Ok(OperationSuccess::new(CatalogOutput {
                total,
                presets,
                has_more,
                text_sfx_presets: text_sfx_catalog().clone(),
            }))
        },
    )?;
    register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.transitions.apply",
        "Apply or remove in/out transitions",
        "Atomically apply 1..1000 transition applications to explicit Classic scene clips. Describe/read the live catalog for presetId; side is in/out. percent defaults to 5, clamps 0..100, with minimum 10 for flicker; default duration is capped at 3 seconds (360000 ticks). Optional explicit duration must fit the clip. In anchors at zero, out at clip.duration-transition.duration. none removes that side. Preserves the opposite transition and unrelated clip state, and strips animation channels owned by the resulting transition presets using the product's existing policy. Fresh semantic transition IDs and creation timestamps are allocated by the runtime. Audio/effect clips are unsupported and any invalid target rejects the entire batch. Supports project/scene/revision checks, dry run, idempotency, cancellation, transactions and Undo/Redo. managedTextSfx defaults false. When true, replace managed companion audio for targeted text IDs and insert authored shared-library SFX from the catalog for matching preset/side, preserving source trims, volume and timing. Unrelated audio is retained. This does not download or verify shared-library bytes and excludes visual overlap rearrangement; verify current rendered frames after applying.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["classic", "transition", "in", "out", "fade", "מעבר"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Apply Classic transitions",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "Transition project is not active".into(),
                            ));
                        }
                        let mut scene = project
                            .classic
                            .as_ref()
                            .ok_or_else(|| invalid("Requires a Classic project"))?
                            .document["scenes"]
                            .as_array()
                            .and_then(|v| v.iter().find(|s| s["id"] == input.scene_id))
                            .ok_or_else(|| invalid("Scene not found"))?
                            .clone();
                        let mut occupied = HashSet::new();
                        collect_ids(
                            &serde_json::to_value(&document.project).unwrap(),
                            &mut occupied,
                        );
                        let mut changed = vec![];
                        if input.managed_text_sfx {
                            let targets: HashSet<_> = input
                                .applications
                                .iter()
                                .map(|app| app.element_id.as_str())
                                .collect();
                            for track in scene["tracks"]["audio"].as_array_mut().unwrap() {
                                track["elements"].as_array_mut().unwrap().retain(|e| {
                                    !(e["params"][SFX_KIND] == "text-transition-in-sfx"
                                        && e["params"][SFX_TEXT]
                                            .as_str()
                                            .is_some_and(|id| targets.contains(id)))
                                });
                            }
                        }
                        for app in &input.applications {
                            if context.cancellation.is_cancelled() {
                                return Err(CapabilityError::Failed(
                                    "Transition apply cancelled".into(),
                                ));
                            }
                            preset(&app.preset_id)?;
                            let source = all(&scene["tracks"])
                                .find(|t| t["id"] == app.track_id)
                                .and_then(|t| t["elements"].as_array())
                                .and_then(|v| v.iter().find(|e| e["id"] == app.element_id))
                                .ok_or_else(|| invalid("Transition clip not found"))?
                                .clone();
                            if matches!(source["type"].as_str(), Some("audio" | "effect")) {
                                return Err(invalid("Transition target cannot be audio or effect"));
                            }
                            let duration = ticks(&source["duration"])?;
                            let mut next = source.clone();
                            let mut transitions = source["transitions"]
                                .as_object()
                                .cloned()
                                .unwrap_or_default();
                            if app.preset_id == "none" {
                                transitions.remove(app.side.key());
                            } else {
                                let percent = app.percent.unwrap_or(5.0).clamp(0.0, 100.0);
                                let percent = if app.preset_id == "flicker" {
                                    percent.max(10.0)
                                } else {
                                    percent
                                };
                                let span = app.duration.unwrap_or(
                                    ((duration as f64 * percent / 100.0).min(360000.0) + 0.5)
                                        .floor() as i64,
                                );
                                if span < 0 || span > duration {
                                    return Err(invalid("Transition duration must fit its clip"));
                                }
                                transitions.insert(app.side.key().into(),json!({"id":classic_duplicate::fresh(document,&mut occupied,"transition"),"presetId":app.preset_id,"placement":app.side,"duration":span,"startTime":if matches!(app.side,Side::Out){duration-span}else{0},"createdAt":timestamp()}));
                            }
                            let in_id = transitions
                                .get("in")
                                .and_then(|t| t["presetId"].as_str())
                                .unwrap_or("none");
                            let out_id = transitions
                                .get("out")
                                .and_then(|t| t["presetId"].as_str())
                                .unwrap_or("none");
                            let owned: HashSet<_> = properties(preset(in_id)?)
                                .into_iter()
                                .chain(properties(preset(out_id)?))
                                .collect();
                            if let Some(animations) =
                                next.get_mut("animations").and_then(Value::as_object_mut)
                            {
                                animations.retain(|path, _| !owned.contains(path.as_str()));
                                if animations.is_empty() {
                                    next.as_object_mut().unwrap().remove("animations");
                                }
                            }
                            if transitions.get("in").is_none() && transitions.get("out").is_none() {
                                next.as_object_mut().unwrap().remove("transitions");
                            } else {
                                next["transitions"] = json!(transitions);
                            }
                            *track_mut(&mut scene["tracks"], &app.track_id).unwrap()["elements"]
                                .as_array_mut()
                                .unwrap()
                                .iter_mut()
                                .find(|e| e["id"] == app.element_id)
                                .unwrap() = next;
                            changed.push(app.element_id.clone());
                            if input.managed_text_sfx {
                                if let Some(mut audio) = companion(&source, app)? {
                                    audio["id"] = json!(classic_duplicate::fresh(
                                        document,
                                        &mut occupied,
                                        "element"
                                    ));
                                    let new_track =
                                        classic_duplicate::fresh(document, &mut occupied, "track");
                                    classic_insert::place_library_audio(
                                        &mut scene, &mut audio, &new_track,
                                    )?;
                                    changed.push(audio["id"].as_str().unwrap().to_owned());
                                }
                            }
                        }
                        *project_mut(document)?.classic.as_mut().unwrap().document["scenes"]
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|s| s["id"] == input.scene_id)
                            .unwrap() = scene;
                        Ok(changed)
                    },
                )?;
                Ok(OperationSuccess::new(mutation).changed([
                    STATE_RESOURCE,
                    PROJECT_RESOURCE,
                    TIMELINE_RESOURCE,
                ]))
            }
        },
    )
}
