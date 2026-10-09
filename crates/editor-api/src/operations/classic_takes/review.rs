//! Experimental inference context and bounded selection patches. No project mutation or IO.
use super::*;

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) enum Mode {
    #[default]
    Standard,
    Experimental,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RunMetrics {
    pub elapsed_ms: u64,
    pub stages: Vec<StageTiming>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StageTiming {
    pub stage: String,
    pub duration_ms: u64,
}
impl RunMetrics {
    pub fn validate(&self) -> Result<(), String> {
        if self.elapsed_ms > 86_400_000
            || self.stages.len() > 20
            || self
                .stages
                .iter()
                .any(|s| s.stage.is_empty() || s.stage.len() > 200 || s.duration_ms > 86_400_000)
        {
            return Err("Invalid take run metrics".into());
        }
        Ok(())
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    group_index: usize,
    alternative_index: usize,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 1000))]
    element_ids: Vec<String>,
    plan: Plan,
    #[serde(default)]
    #[schemars(length(max = 1000))]
    selections: Vec<Selection>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct StoryBeat {
    group_index: usize,
    label: String,
    selected: usize,
    dialogue: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    alternative_index: usize,
    label: String,
    dialogue: String,
    parts: Vec<Part>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReviewGroup {
    group_index: usize,
    reasons: Vec<String>,
    alternatives: Vec<Candidate>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct DiscardedDialogue {
    first_word: usize,
    last_word: usize,
    reason: String,
    dialogue: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    plan: Plan,
    story: Vec<StoryBeat>,
    groups: Vec<ReviewGroup>,
    discarded: Vec<DiscardedDialogue>,
}
fn dialogue(parts: &[Part], words: &[Word]) -> String {
    parts
        .iter()
        .map(|p| {
            words[p.first_word..=p.last_word]
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join(" | ")
}
fn risks(group: &Group, words: &[Word]) -> Vec<String> {
    let alt = Alternative {
        parts: quality::merged(&group.alternatives[group.selected].parts, words),
        ..group.alternatives[group.selected].clone()
    };
    let mut reasons = vec![];
    if group.confidence < 0.85 {
        reasons.push("low semantic confidence".into());
    }
    if alt.parts.len() > 1 {
        reasons.push("composite performance".into());
    }
    // Review tiny standalone beats too: a chopped sentence can span groups,
    // even when each selected alternative has only one continuous part.
    if quality::short(&alt, words) > 0
        || alt.parts.iter().any(|p| p.last_word - p.first_word + 1 < 4)
    {
        reasons.push("short fragment".into());
    }
    if quality::repeats(&alt, words) > 0 {
        reasons.push("repeated phrase".into());
    }
    reasons
}
pub(super) fn register_review(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
) -> Result<(), RegistryError> {
    register::<Input, Output, _, _>(registry, DocumentSupport::Classic, crate::CapabilityExecution::Immediate,
        "timeline.classic.takes.review", "Prepare experimental take review",
        "Read-only experimental review: validate a complete draft against explicit selected source clips, return all selected dialogue and discarded dialogue plus alternatives only for risky groups. Optional selections change recommendations in the returned proposal only, restricted to flagged groups. Never changes editor state. Full source coverage, project/revision and cancellation checks apply. Use takes.edit to commit the final proposal with undo/dry-run support. No IO or inference.",
        "timeline", AccessLevel::Read, true, false, &["classic", "takes", "experimental", "review"],
        move |context, input| { let state = state.clone(); async move {
            if context.cancellation.is_cancelled() { return Err(CapabilityError::Failed("Take review cancelled".into())); }
            let store = state.read().map_err(|_| invalid("State lock poisoned"))?;
            if store.active_project_id() != Some(input.project_id.as_str()) || store.document.revision != input.expected_revision {
                return Err(CapabilityError::Conflict("Take source project or revision changed".into()));
            }
            let classic = store.document.project.as_ref().and_then(|p| p.classic.as_ref()).ok_or_else(|| invalid("Classic project required"))?;
            let scene = arr(&classic.document["scenes"]).iter().find(|s| s["id"] == input.scene_id).ok_or_else(|| invalid("Scene not found"))?;
            let (words, _, _) = inventory(&scene["tracks"], &input.element_ids, true)?;
            validate_plan(&input.plan, &words)?;
            let groups: Vec<_> = input.plan.groups.iter().enumerate().filter_map(|(i,g)| {
                let reasons = risks(g, &words);
                (!reasons.is_empty()).then(|| ReviewGroup { group_index: i, reasons, alternatives: g.alternatives.iter().enumerate().map(|(index,a)| Candidate {
                    alternative_index: index, label: a.label.clone(), dialogue: dialogue(&a.parts, &words), parts: a.parts.clone(),
                }).collect() })
            }).collect();
            if input.selections.len() > 1000 { return Err(invalid("Too many review selections")); }
            let mut plan = input.plan;
            let mut seen = HashSet::new();
            for s in input.selections {
                if !seen.insert(s.group_index) || !groups.iter().any(|g| g.group_index == s.group_index) {
                    return Err(invalid("Experimental review may select each flagged group only once"));
                }
                let g = &mut plan.groups[s.group_index];
                if s.alternative_index >= g.alternatives.len() { return Err(invalid("Review alternative out of bounds")); }
                g.selected = s.alternative_index;
            }
            validate_plan(&plan, &words)?;
            let story = plan.groups.iter().enumerate().map(|(i,g)| StoryBeat { group_index:i, label:g.label.clone(), selected:g.selected, dialogue:dialogue(&g.alternatives[g.selected].parts,&words) }).collect();
            let discarded = plan.discarded.iter().map(|d| DiscardedDialogue { first_word:d.first_word,last_word:d.last_word,reason:d.reason.clone(),dialogue:dialogue(&[Part{first_word:d.first_word,last_word:d.last_word}],&words) }).collect();
            Ok(OperationSuccess::new(Output { plan, story, groups, discarded }))
        }})
}
