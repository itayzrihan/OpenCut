//! Classic-only editable nested B-roll, owned by the canonical document.
use super::classic_scenes::{classic_target, timestamp};
use super::*;
use serde_json::json;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Edge {
    Top,
    Bottom,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    scene_id: String,
    edge: Edge,
    start_time: i64,
    duration: i64,
    #[serde(default = "default_percent")]
    screen_percent: f64,
    #[serde(default = "default_transition")]
    transition_seconds: f64,
}
fn default_percent() -> f64 {
    40.0
}
fn default_transition() -> f64 {
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
        "timeline.classic.push-broll.create",
        "Add an editable upper or lower B-roll scene",
        "Creates an empty nested scene and a synchronized push B-roll effect at startTime/duration (Classic ticks, 120000 per second). Default band is 40% with 0.4-second entry and exit. Edit the nested scene with existing timeline capabilities. Classic-only; preserves dialogue audio. Requires projectId and expectedRevision. Supports undo, dry run, cancellation, atomic transactions and registry idempotency keys.",
        "scene",
        AccessLevel::Write,
        false,
        false,
        &["classic", "broll", "nested", "animation"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Add push B-roll",
                    Some(input.expected_revision),
                    |document| {
                        if input.start_time < 0
                            || input.duration <= 0
                            || input
                                .start_time
                                .checked_add(input.duration)
                                .is_none_or(|end| end > 9_007_199_254_740_991)
                            || !input.screen_percent.is_finite()
                            || !(1.0..=90.0).contains(&input.screen_percent)
                            || !input.transition_seconds.is_finite()
                            || !(0.0..=10.0).contains(&input.transition_seconds)
                        {
                            return Err(CapabilityError::InvalidInput(
                                "Invalid B-roll timing, screen percent or transition duration"
                                    .into(),
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
                        let track_id = fresh("track");
                        let element_id = fresh("element");
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
                                CapabilityError::InvalidInput("Parent scene not found".into())
                            })?;
                        let edge = match input.edge {
                            Edge::Top => "top",
                            Edge::Bottom => "bottom",
                        };
                        let name = format!("B-roll from {edge}");
                        let tracks = scene["tracks"].as_object_mut().unwrap();
                        tracks.get_mut("overlay").unwrap().as_array_mut().unwrap().insert(0, json!({
                        "id":track_id, "name":name, "type":"effect", "hidden":false, "keepEmpty":true,
                        "elements":[{"id":element_id,"type":"effect","effectType":"push-broll","name":name,
                            "startTime":input.start_time,"duration":input.duration,"trimStart":0,"trimEnd":0,
                            "params":{"brollSceneId":nested_id,"edge":edge,"screenPercent":input.screen_percent,"transitionSeconds":input.transition_seconds}}]
                    }));
                        if let Some(order) = tracks.get_mut("order").and_then(Value::as_array_mut) {
                            order.insert(0, json!(track_id));
                        }
                        scene["updatedAt"] = json!(now);
                        scenes.push(json!({"id":nested_id,"name":name,"isMain":false,"brollParentSceneId":input.scene_id,"createdAt":now,"updatedAt":now,"bookmarks":[],
                        "tracks":{"overlay":[],"audio":[],"order":[main_id],"main":{"id":main_id,"name":"Main Track","type":"video","elements":[],"muted":false,"hidden":false}}}));
                        classic.document.get_mut("metadata").unwrap()["updatedAt"] = json!(now);
                        Ok(vec![input.project_id, nested_id, track_id, element_id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Created editable push B-roll scene")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
