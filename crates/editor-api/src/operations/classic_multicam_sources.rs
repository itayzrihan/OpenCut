//! Canonical microphone suggestions. Filename evidence is a hint, never identity.
use super::*;
use serde_json::{Map, Value};

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 32))]
    video_ids: Vec<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    audio_id: String,
    score: u32,
    reason: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Suggestion {
    video_id: String,
    audio_id: Option<String>,
    candidates: Vec<Candidate>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    revision: u64,
    has_external_audio: bool,
    suggestions: Vec<Suggestion>,
}
fn stem(name: &str) -> String {
    name.rsplit_once('.')
        .map_or(name, |(base, _)| base)
        .to_lowercase()
}
fn tokens(name: &str) -> Vec<String> {
    // Digits delimit recorder/camera prefixes (C7453lior, 0144_1lior).
    // Unicode alphabetic characters keep Hebrew names intact.
    stem(name)
        .split(|c: char| !c.is_alphabetic())
        .filter(|s| s.chars().count() >= 3)
        .filter(|s| {
            ![
                "audio",
                "video",
                "camera",
                "mic",
                "microphone",
                "recording",
                "take",
                "wav",
                "mp4",
            ]
            .contains(s)
        })
        .map(str::to_owned)
        .collect()
}
fn score(video: &str, audio: &str) -> (u32, String) {
    let a = stem(video);
    let b = stem(audio);
    let compact = |s: &str| {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>()
    };
    if !compact(&a).is_empty() && compact(&a) == compact(&b) {
        return (100, "Matching filename".into());
    }
    let shared: Vec<_> = tokens(video)
        .into_iter()
        .filter(|t| tokens(audio).contains(t))
        .collect();
    if !shared.is_empty() {
        return (
            80 + (shared.len().min(3) as u32 * 5),
            format!("Shared name: {}", shared.join(", ")),
        );
    }
    // A person name may be appended to arbitrary original filename text.
    // Keep this weaker than a whole shared token; ties still require a choice.
    for a in tokens(video) {
        for b in tokens(audio) {
            if a.contains(&b) || b.contains(&a) {
                let name = if a.len() < b.len() { &a } else { &b };
                return (70, format!("Name inside filename: {name}"));
            }
        }
    }
    (0, "Choose manually: no shared name".into())
}
pub(super) fn register_sources(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
) -> Result<(), RegistryError> {
    register::<Input, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.multicam.sources.suggest",
        "Suggest external podcast microphones",
        "Rank registered external audio by shared Unicode person-name tokens embedded in camera/recorder filenames, ignoring numeric prefixes and file extensions. Returns evidence scores (not calibrated probabilities) and editable candidates. Only unique, non-conflicting best matches are selected. No order-based pairing; ambiguous/missing matches remain null. Camera audio is suggested only when no external audio exists. Read-only, explicit project and optimistic revision; no IO or history changes. Bridged Classic policy.",
        "timeline",
        AccessLevel::Read,
        true,
        false,
        &["classic", "multicam", "podcast", "microphone", "sources"],
        move |context, input| {
            let state = state.clone();
            async move {
                let store = state
                    .read()
                    .map_err(|_| CapabilityError::Failed("State lock poisoned".into()))?;
                if store.document.revision != input.expected_revision {
                    return Err(CapabilityError::Conflict(
                        "Podcast project revision changed".into(),
                    ));
                }
                let project = store
                    .document
                    .project
                    .as_ref()
                    .filter(|p| p.id == input.project_id)
                    .ok_or_else(|| CapabilityError::Conflict("Podcast project changed".into()))?;
                let classic = project.classic.as_ref().ok_or_else(|| {
                    CapabilityError::Unavailable("Classic project required".into())
                })?;
                if input.video_ids.is_empty()
                    || input.video_ids.len() > 32
                    || input.video_ids.iter().collect::<HashSet<_>>().len() != input.video_ids.len()
                {
                    return Err(CapabilityError::InvalidInput(
                        "Choose 1 to 32 unique cameras".into(),
                    ));
                }
                let external: Vec<&Map<String, Value>> = classic
                    .media_assets
                    .iter()
                    .filter(|a| a["type"] == "audio")
                    .collect();
                let mut suggestions = Vec::new();
                for id in &input.video_ids {
                    if context.cancellation.is_cancelled() {
                        return Err(CapabilityError::Failed("operation was cancelled".into()));
                    }
                    let video = classic
                        .media_assets
                        .iter()
                        .find(|a| a["id"] == *id && a["type"] == "video")
                        .ok_or_else(|| {
                            CapabilityError::InvalidInput("Unknown podcast camera".into())
                        })?;
                    let mut candidates: Vec<_> = external
                        .iter()
                        .filter(|a| a.get("missing") != Some(&Value::Bool(true)))
                        .map(|a| {
                            let (score, reason) = score(
                                video["name"].as_str().unwrap_or(""),
                                a["name"].as_str().unwrap_or(""),
                            );
                            Candidate {
                                audio_id: a["id"].as_str().unwrap().to_owned(),
                                score,
                                reason,
                            }
                        })
                        .collect();
                    candidates.sort_by(|a, b| {
                        b.score
                            .cmp(&a.score)
                            .then_with(|| a.audio_id.cmp(&b.audio_id))
                    });
                    let audio_id = if external.is_empty()
                        && video.get("hasAudio") != Some(&Value::Bool(false))
                    {
                        Some(id.clone())
                    } else if candidates.first().is_some_and(|c| {
                        c.score > 0 && candidates.get(1).is_none_or(|n| n.score < c.score)
                    }) {
                        Some(candidates[0].audio_id.clone())
                    } else {
                        None
                    };
                    suggestions.push(Suggestion {
                        video_id: id.clone(),
                        audio_id,
                        candidates,
                    });
                }
                // Never let asset/channel order decide which camera gets a shared mic.
                let chosen: Vec<_> = suggestions
                    .iter()
                    .filter_map(|s| s.audio_id.clone())
                    .collect();
                for s in &mut suggestions {
                    if s.audio_id
                        .as_ref()
                        .is_some_and(|id| chosen.iter().filter(|x| *x == id).count() > 1)
                    {
                        s.audio_id = None;
                    }
                }
                Ok(OperationSuccess::new(Output {
                    revision: store.document.revision,
                    has_external_audio: !external.is_empty(),
                    suggestions,
                }))
            }
        },
    )
}
