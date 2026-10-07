use super::*;
use classic_timeline::{CaptionCuePlanOptions, CaptionLayoutWord, build_caption_cue_plan};
use serde_json::json;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    track_id: String,
    expected_revision: u64,
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_limit")]
    #[schemars(range(min = 1, max = 500))]
    limit: usize,
}
fn default_limit() -> usize {
    100
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    revision: u64,
    total: usize,
    offset: usize,
    next_offset: Option<usize>,
    cues: Vec<Value>,
}
pub(super) fn register_caption_cues(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
) -> Result<(), RegistryError> {
    register::<Input, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "caption.classic.cues.read",
        "Read Classic generated caption cues",
        "Read generated transcript cues from one explicit Classic text track's captionSource using the same Rust row/timing policy as the product. Supply projectId, sceneId, trackId and expectedRevision. Text-layer-owned manual words are excluded; remaining word metadata is preserved. Cues return text, startTime and duration in SECONDS (timeline clips use 120000 ticks/second) plus source wordIndices and original words. Honors wordsPerRow, rows, semantic rowBreaks, readable one-word windows and in/out padding. Up to 100000 source words; page 1..500 cues using offset/limit. Read only, no font/layout rendering, UI actions, IO or history changes. Use app.state.read to inspect authored clip positions separately.",
        "captions",
        AccessLevel::Read,
        true,
        false,
        &[
            "classic",
            "caption",
            "transcript",
            "cue",
            "words",
            "layout",
            "כתוביות",
        ],
        move |context, input| {
            let state = state.clone();
            async move {
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("operation was cancelled".into()));
                }
                let store = state
                    .read()
                    .map_err(|_| CapabilityError::Failed("state lock poisoned".into()))?;
                if store.active_project_id() != Some(input.project_id.as_str())
                    || store.document.revision != input.expected_revision
                {
                    return Err(CapabilityError::Conflict(
                        "Caption source project or revision changed".into(),
                    ));
                }
                let classic = store
                    .document
                    .project
                    .as_ref()
                    .and_then(|p| p.classic.as_ref())
                    .ok_or_else(|| {
                        CapabilityError::Unavailable("Classic project required".into())
                    })?;
                let source = classic.document["scenes"]
                    .as_array()
                    .and_then(|s| s.iter().find(|s| s["id"] == input.scene_id))
                    .and_then(|s| s["tracks"]["overlay"].as_array())
                    .and_then(|tracks| {
                        tracks
                            .iter()
                            .find(|t| t["id"] == input.track_id && t["type"] == "text")
                    })
                    .and_then(|track| track.get("captionSource"))
                    .filter(|s| s.is_object())
                    .ok_or_else(|| {
                        CapabilityError::InvalidInput("Caption source track not found".into())
                    })?;
                let words = source["words"]
                    .as_array()
                    .filter(|words| words.len() <= 100000)
                    .ok_or_else(|| {
                        CapabilityError::InvalidInput(
                            "Caption source requires a bounded word array".into(),
                        )
                    })?;
                let generated: Vec<(usize, &Value)> = words
                    .iter()
                    .enumerate()
                    .filter(|(_, w)| w["source"]["type"] != "text-layer")
                    .collect();
                let typed = generated
                    .iter()
                    .map(|(_, word)| {
                        serde_json::from_value::<CaptionLayoutWord>(
                            json!({"text":word["text"],"start":word["start"],"end":word["end"]}),
                        )
                        .map_err(|e| {
                            CapabilityError::InvalidInput(format!("Invalid caption word: {e}"))
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let plans = build_caption_cue_plan(CaptionCuePlanOptions {
                    words: typed,
                    settings_json: source["settings"].to_string(),
                });
                let total = plans.len();
                let offset = input.offset.min(total);
                let end = offset.saturating_add(input.limit).min(total);
                let cues=plans[offset..end].iter().map(|cue|json!({"text":cue.text,"startTime":cue.start_time,"duration":cue.duration,
                "wordIndices":cue.word_indices.iter().map(|i|generated[*i].0).collect::<Vec<_>>(),"words":cue.word_indices.iter().map(|i|generated[*i].1.clone()).collect::<Vec<_>>() })).collect();
                Ok(OperationSuccess::new(Output {
                    revision: store.document.revision,
                    total,
                    offset,
                    next_offset: (end < total).then_some(end),
                    cues,
                }))
            }
        },
    )
}
