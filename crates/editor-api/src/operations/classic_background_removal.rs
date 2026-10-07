//! Reuse the product's segmentation settings and placement policy in the registry.
use super::classic_track_layout::{apply_layout, ClassicTrackType, LayoutChange};
use super::*;
use ::classic_background_removal::{
    plan_duplicate_placement, resolve_settings, BackgroundRemovalSettings, DuplicatePlacement,
    DuplicatePlacementInput, TrackSummary,
};
use serde_json::json;
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Remove,
    Blur,
    Grayscale,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Quality {
    Fast,
    Balanced,
    Precise,
}
/// Schema only; defaults, normalization and rendering policy stay in the
/// existing background-removal crate used by the legacy renderer's WASM.
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct Settings {
    enabled: Option<bool>,
    mode: Option<Mode>,
    quality: Option<Quality>,
    mask_threshold: Option<f32>,
    edge_contrast: Option<f32>,
    edge_feather: Option<f32>,
    temporal_smoothing: Option<f32>,
    blur_strength: Option<f32>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    track_id: String,
    element_id: String,
    #[schemars(with = "Settings")]
    settings: Value,
    #[serde(default)]
    duplicate: bool,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Target {
    track_id: String,
    element_id: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    #[serde(flatten)]
    mutation: MutationOutput,
    target: Target,
    created_track: bool,
}
fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn all(tracks: &Value) -> impl Iterator<Item = &Value> {
    tracks["overlay"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(std::iter::once(&tracks["main"]))
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
pub(super) fn register_classic_background_removal(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<Input,Output,_,_>(registry,DocumentSupport::Classic,crate::CapabilityExecution::Immediate,"timeline.classic.background_removal.set","Configure person segmentation or duplicate the person layer",
    "Configure background removal, blur or grayscale for one video clip in a video track. Uses the existing segmentation settings defaults and clamps (threshold .05..95, contrast .5..2.5, feather 0..8, smoothing 0..85, blur 0..1), with fast/balanced/precise quality. duplicate=true preserves the source and creates a same-time person clip with source audio disabled and independent animation IDs. Reuses only a non-overlapping video track immediately above the source; otherwise creates a track immediately above it. Preserves source media, timing, trim, retime, effects, masks and extension fields. Returns exact target IDs and createdTrack. This configures the existing renderer, not a claim that neural inference, every frame or final export was verified; inspect current rendered evidence. Scoped to project/scene/revision, atomic, cancellable, dry-run/idempotent retries and Undo/Redo.","timeline",AccessLevel::Write,false,false,&["classic","background","segmentation","person","remove","blur","רקע","הסרת רקע"],move|context,input|{ let state=state.clone();let events=events.clone();async move {
        let mut target=Target{track_id:input.track_id.clone(),element_id:input.element_id.clone()};let mut created_track=false;
        let mutation=mutate(&state,&events,&context,"Configure background removal",Some(input.expected_revision),|document|{
            let project=project_mut(document)?;if project.id!=input.project_id{return Err(CapabilityError::Conflict("Background removal project is not active".into()));}
            let before=project.classic.as_ref().ok_or_else(||invalid("Requires a Classic project"))?.document["scenes"].as_array().and_then(|v|v.iter().find(|s|s["id"]==input.scene_id)).ok_or_else(||invalid("Scene not found"))?.clone();let tracks=&before["tracks"];
            let source=all(tracks).find(|t|t["id"]==input.track_id&&t["type"]=="video").and_then(|t|t["elements"].as_array()).and_then(|v|v.iter().find(|e|e["id"]==input.element_id&&e["type"]=="video")).ok_or_else(||invalid("Requires an existing video clip in a video track"))?;
            let settings:BackgroundRemovalSettings=serde_json::from_value(input.settings.clone()).map_err(|e|invalid(&e.to_string()))?;let settings=serde_json::to_value(resolve_settings(settings).settings).map_err(|e|invalid(&e.to_string()))?;
            let mut copy=source.clone();copy["backgroundRemoval"]=settings;
            let mut scene=before.clone();
            if input.duplicate {
                let all:Vec<_>=all(tracks).collect();let mut order:Vec<String>=vec![];
                for id in tracks["order"].as_array().into_iter().flatten().filter_map(Value::as_str).chain(all.iter().filter_map(|t|t["id"].as_str())) {if all.iter().any(|t|t["id"]==id)&&!order.iter().any(|v|v==id){order.push(id.into());}}
                let source_track_index=order.iter().position(|id|id==&input.track_id).ok_or_else(||invalid("Source track not in display order"))?;
                let summaries:Vec<TrackSummary>=order.iter().map(|id|{let track=all.iter().find(|t|t["id"]==*id).unwrap();let kind=if track["type"]=="parallax"{"effect"}else{track["type"].as_str().unwrap_or("effect")};serde_json::from_value(json!({"id":id,"trackType":kind,"spans":track["elements"].as_array().into_iter().flatten().map(|e|json!({"startTime":e["startTime"],"duration":e["duration"]})).collect::<Vec<_>>()})).map_err(|e|invalid(&e.to_string()))}).collect::<Result<_,_>>()?;
                let placement=plan_duplicate_placement(&DuplicatePlacementInput{source_track_index,source_start_time:source["startTime"].as_f64().unwrap_or(-1.0),source_duration:source["duration"].as_f64().unwrap_or(0.0),tracks:summaries}).map_err(|_|invalid("Invalid duplicate source span"))?;
                let mut occupied=HashSet::new();collect_ids(&serde_json::to_value(&document.project).unwrap(),&mut occupied);
                target.element_id=classic_duplicate::fresh(document,&mut occupied,"classic-clip");copy["id"]=json!(target.element_id);copy["name"]=json!(format!("{} (person)",source["name"].as_str().unwrap_or("")));copy["isSourceAudioEnabled"]=json!(false);classic_duplicate::clone_animation(document,&mut occupied,&mut copy)?;
                match placement { DuplicatePlacement::ExistingTrack{track_id}=>target.track_id=track_id,DuplicatePlacement::NewTrack{insert_index}=>{
                    target.track_id=classic_duplicate::fresh(document,&mut occupied,"classic-track");created_track=true;apply_layout(&mut scene,LayoutChange::Add{track_id:target.track_id.clone(),track_type:ClassicTrackType::Video,name:None,index:Some(insert_index as i64)})?;track_mut(&mut scene["tracks"],&target.track_id).unwrap().as_object_mut().unwrap().remove("keepEmpty");
                }}
                track_mut(&mut scene["tracks"],&target.track_id).unwrap()["elements"].as_array_mut().unwrap().push(copy);
            } else {let items=track_mut(&mut scene["tracks"],&input.track_id).unwrap()["elements"].as_array_mut().unwrap();*items.iter_mut().find(|e|e["id"]==input.element_id).unwrap()=copy;}
            let active=project_mut(document)?.classic.as_mut().unwrap().document["scenes"].as_array_mut().unwrap().iter_mut().find(|s|s["id"]==input.scene_id).unwrap();*active=scene;
            Ok(vec![target.track_id.clone(),target.element_id.clone()])
        })?;Ok(OperationSuccess::new(Output{mutation,target,created_track}).changed([STATE_RESOURCE,PROJECT_RESOURCE,TIMELINE_RESOURCE]))
    }})
}
