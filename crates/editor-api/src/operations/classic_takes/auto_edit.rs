//! Freeze the currently chosen cut sequence for fresh automatic editing, without media IO.
use super::*;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
}

pub(super) fn register_auto_edit(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.takes.prepare_auto_edit",
        "Prepare selected takes for Full Auto Edit",
        "Keep the current main-track video cuts, source trims, order and synchronized audio. Remove all text tracks, caption sources and take alternatives from the live scene so Full Auto Edit transcribes the edited audio afresh. Does not render, join or delete source media. Rejects non-video main clips, animated/retimed clips and populated non-text overlays before changing anything. Undo restores the complete assembly and transcript. Explicit project/scene/revision; registry idempotency, dry run, cancellation and transactions. Read back through app.state.read.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["classic", "takes", "full-auto-edit", "transcript"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Prepare takes for Full Auto Edit",
                    Some(input.expected_revision),
                    |document| {
                        let classic = classic_scenes::classic_target(document, &input.project_id)?;
                        let scene = classic.document["scenes"]
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|s| s["id"] == input.scene_id)
                            .ok_or_else(|| invalid("Scene not found"))?;
                        if !scene["takeAssembly"].is_object() {
                            return Err(invalid("This scene has no Smart Takes assembly"));
                        }
                        let tracks = &mut scene["tracks"];
                        let clips = arr(&tracks["main"]["elements"]);
                        if clips.is_empty()
                            || clips
                                .iter()
                                .any(|e| !classic_timeline::supports_full_auto_framing(e))
                        {
                            return Err(invalid(
                                "Full Auto Edit requires main-track video without retiming or animated transforms",
                            ));
                        }
                        if arr(&tracks["overlay"])
                            .iter()
                            .any(|t| t["type"] != "text" && !arr(&t["elements"]).is_empty())
                        {
                            return Err(invalid(
                                "Remove non-text overlays before starting Full Auto Edit",
                            ));
                        }
                        let removed: HashSet<String> = arr(&tracks["overlay"])
                            .iter()
                            .filter(|t| t["type"] == "text")
                            .filter_map(|t| t["id"].as_str().map(str::to_owned))
                            .collect();
                        tracks["overlay"]
                            .as_array_mut()
                            .unwrap()
                            .retain(|t| t["type"] != "text");
                        if let Some(order) = tracks["order"].as_array_mut() {
                            order.retain(|id| !id.as_str().is_some_and(|s| removed.contains(s)));
                        }
                        for element in tracks["main"]["elements"].as_array_mut().unwrap() {
                            element.as_object_mut().unwrap().remove("takeGroup");
                        }
                        scene.as_object_mut().unwrap().remove("takeAssembly");
                        classic.document["metadata"]["updatedAt"] =
                            json!(classic_scenes::timestamp()?);
                        Ok(vec![input.project_id, input.scene_id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Prepared chosen cuts for fresh automatic editing without rendering")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
