//! Text-owned nested graphics; Classic-only canonical state.
use super::classic_scenes::{classic_target, timestamp};
use super::*;
use serde_json::json;
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Edge {
    Top,
    Bottom,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    scene_id: String,
    track_id: String,
    element_id: String,
    edge: Edge,
    #[serde(default = "size")]
    size_percent: f64,
    #[serde(default = "transition")]
    transition_seconds: f64,
}
fn size() -> f64 {
    20.0
}
fn transition() -> f64 {
    0.4
}
pub(super) fn register(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    super::register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.text-graphics.create",
        "Attach editable graphics above or below text",
        "Creates an empty nested content scene linked to one text element. Populate it using existing timeline insert/catalog capabilities with icons, UI Elements, graphics, media or HyperFrames. Top graphics push only the target text down; bottom graphics push it up. Attachment follows text timing. Supports optimistic revision, dry run, cancellation, atomic transactions, idempotency and undo. Returns project, content scene and target IDs; content scene is readable through app.state.read. No automatic semantic asset generation is performed by creation.",
        "text",
        AccessLevel::Write,
        false,
        false,
        &["classic", "text", "graphics", "nested", "animation"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Attach text graphics",
                    Some(input.expected_revision),
                    |document| {
                        if !input.size_percent.is_finite()
                            || !(1.0..=60.0).contains(&input.size_percent)
                            || !input.transition_seconds.is_finite()
                            || !(0.0..=10.0).contains(&input.transition_seconds)
                        {
                            return Err(CapabilityError::InvalidInput(
                                "Invalid graphics size or transition".into(),
                            ));
                        }
                        let mut occupied = HashSet::new();
                        collect_ids(&serde_json::to_value(&*document).unwrap(), &mut occupied);
                        let mut fresh = |prefix: &str| loop {
                            let id = document.allocate_id(prefix);
                            if occupied.insert(id.clone()) {
                                break id;
                            }
                        };
                        let nested_id = fresh("scene");
                        let main_id = fresh("track");
                        let classic = classic_target(document, &input.project_id)?;
                        let now = timestamp()?;
                        let scenes = classic
                            .document
                            .get_mut("scenes")
                            .and_then(Value::as_array_mut)
                            .unwrap();
                        let scene = scenes
                            .iter_mut()
                            .find(|s| s["id"] == input.scene_id)
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput("Scene not found".into())
                            })?;
                        let tracks = &mut scene["tracks"];
                        let track = if tracks["main"]["id"] == input.track_id {
                            tracks.get_mut("main").unwrap()
                        } else {
                            tracks["overlay"]
                                .as_array_mut()
                                .unwrap()
                                .iter_mut()
                                .find(|t| t["id"] == input.track_id)
                                .ok_or_else(|| {
                                    CapabilityError::InvalidInput("Text track not found".into())
                                })?
                        };
                        let text = track["elements"]
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|e| e["id"] == input.element_id && e["type"] == "text")
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput(
                                    "Target must be a text element".into(),
                                )
                            })?;
                        let params = text["params"].as_object_mut().ok_or_else(|| {
                            CapabilityError::InvalidInput("Missing text params".into())
                        })?;
                        if params.contains_key("textGraphicsSceneId") {
                            return Err(CapabilityError::Conflict(
                                "Text already has a graphics scene; edit its existing content"
                                    .into(),
                            ));
                        }
                        let edge = match input.edge {
                            Edge::Top => "top",
                            Edge::Bottom => "bottom",
                        };
                        params.insert("textGraphicsSceneId".into(), json!(nested_id));
                        params.insert("textGraphicsEdge".into(), json!(edge));
                        params.insert("textGraphicsSizePercent".into(), json!(input.size_percent));
                        params.insert(
                            "textGraphicsTransitionSeconds".into(),
                            json!(input.transition_seconds),
                        );
                        scene["updatedAt"] = json!(now);
                        scenes.push(json!({"id":nested_id,"name":format!("Graphics {edge} text"),"isMain":false,"brollParentSceneId":input.scene_id,"createdAt":now,"updatedAt":now,"bookmarks":[],"tracks":{"overlay":[],"audio":[],"order":[main_id],"main":{"id":main_id,"name":"Main Track","type":"video","elements":[],"muted":false,"hidden":false}}}));
                        classic.document.get_mut("metadata").unwrap()["updatedAt"] = json!(now);
                        Ok(vec![input.project_id, nested_id, input.element_id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Attached editable text graphics")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
