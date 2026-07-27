use std::collections::BTreeSet;

use bridge::export;
use serde::{Deserialize, Serialize};

const DEFAULT_RESULT_LIMIT: usize = 5;
const MAX_RESULT_LIMIT: usize = 30;
const MIN_RANGE_PREVIEW_FRAMES: usize = 2;
const MAX_RANGE_PREVIEW_FRAMES: usize = 4;
const PREVIEW_TICKS_PER_SECOND: f64 = 120_000.0;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolDescriptor {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub keywords: Vec<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchAgentToolsOptions {
    pub query: String,
    pub tools: Vec<AgentToolDescriptor>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolSearchMatch {
    pub name: String,
    pub score: u32,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAgentRangePreviewFramesOptions {
    pub start_time: f64,
    pub end_time: f64,
    #[serde(default)]
    pub max_frames: Option<usize>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRangePreviewFramePlan {
    pub valid: bool,
    pub times: Vec<f64>,
    pub reason: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilityDescriptor {
    pub name: String,
    pub risk: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub idempotent: bool,
    #[serde(default)]
    pub open_world: bool,
    #[serde(default)]
    pub required_permissions: Vec<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizeAgentCapabilitiesOptions {
    pub capabilities: Vec<AgentCapabilityDescriptor>,
    #[serde(default)]
    pub granted_permissions: Vec<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilityDecision {
    pub name: String,
    pub allowed: bool,
    pub execution_policy: String,
    pub reason: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizeRegisteredAgentCapabilitiesOptions {
    pub names: Vec<String>,
    #[serde(default)]
    pub granted_permissions: Vec<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredAgentCapabilityDecision {
    pub name: String,
    pub allowed: bool,
    pub execution_policy: String,
    pub reason: String,
    pub risk: String,
    pub read_only: bool,
    pub idempotent: bool,
    pub open_world: bool,
    pub required_permissions: Vec<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskState {
    pub task_id: Option<String>,
    pub kind: Option<String>,
    pub status: String,
    pub progress_basis_points: u16,
    pub phase: Option<String>,
    pub error: Option<String>,
}

impl Default for AgentTaskState {
    fn default() -> Self {
        Self {
            task_id: None,
            kind: None,
            status: "idle".to_owned(),
            progress_basis_points: 0,
            phase: None,
            error: None,
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub progress_basis_points: Option<u16>,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionAgentTaskOptions {
    pub state: AgentTaskState,
    pub event: AgentTaskEvent,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskTransitionDecision {
    pub allowed: bool,
    pub reason: String,
    pub state: AgentTaskState,
}

/// Rank a large tool catalog without putting every JSON schema in the model's
/// context. The scorer is deterministic and intentionally lexical: tool
/// authors can improve recall with concise categories and explicit synonyms.
#[export]
pub fn search_agent_tools(options: SearchAgentToolsOptions) -> Vec<AgentToolSearchMatch> {
    let limit = options
        .limit
        .unwrap_or(DEFAULT_RESULT_LIMIT)
        .clamp(1, MAX_RESULT_LIMIT);
    let normalized_query = normalize(&options.query);
    let query_terms = terms(&normalized_query);

    let mut matches = options
        .tools
        .into_iter()
        .filter_map(|tool| {
            let score = score_tool(&normalized_query, &query_terms, &tool);
            (score > 0).then_some(AgentToolSearchMatch {
                name: tool.name,
                score,
            })
        })
        .collect::<Vec<_>>();

    matches.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.name.cmp(&right.name))
    });
    matches.truncate(limit);
    matches
}

/// Choose a small, deterministic set of interior moments for visual range
/// inspection. Keeping this policy in shared domain code makes every UI shell
/// enforce the same 2-4 frame budget while renderers remain platform-specific.
#[export]
pub fn plan_agent_range_preview_frames(
    options: PlanAgentRangePreviewFramesOptions,
) -> AgentRangePreviewFramePlan {
    let start_time = options.start_time;
    let end_time = options.end_time;
    if !start_time.is_finite()
        || !end_time.is_finite()
        || start_time.fract() != 0.0
        || end_time.fract() != 0.0
        || start_time < 0.0
        || end_time - start_time < MIN_RANGE_PREVIEW_FRAMES as f64
    {
        return AgentRangePreviewFramePlan {
            valid: false,
            times: vec![],
            reason: Some(
                "Range preview needs finite integer ticks and a positive range of at least two ticks"
                    .to_owned(),
            ),
        };
    }

    let duration = end_time - start_time;
    let duration_seconds = duration / PREVIEW_TICKS_PER_SECOND;
    let duration_frame_count = if duration_seconds <= 4.0 {
        2
    } else if duration_seconds <= 12.0 {
        3
    } else {
        4
    };
    let frame_count = duration_frame_count.min(
        options
            .max_frames
            .unwrap_or(MAX_RANGE_PREVIEW_FRAMES)
            .clamp(MIN_RANGE_PREVIEW_FRAMES, MAX_RANGE_PREVIEW_FRAMES),
    );

    let mut times = Vec::with_capacity(frame_count);
    for index in 0..frame_count {
        // Sample segment midpoints instead of exact range edges. This avoids
        // returning a prior/next shot at a half-open edit boundary.
        let fraction = (index as f64 + 0.5) / frame_count as f64;
        let time = (start_time + duration * fraction)
            .round()
            .clamp(start_time, end_time - 1.0);
        if times.last().copied() != Some(time) {
            times.push(time);
        }
    }

    AgentRangePreviewFramePlan {
        valid: times.len() >= MIN_RANGE_PREVIEW_FRAMES,
        reason: (times.len() < MIN_RANGE_PREVIEW_FRAMES)
            .then(|| "Range is too short to choose two distinct preview moments".to_owned()),
        times,
    }
}

/// Resolve tool authorization and approval policy in shared domain code so UI
/// shells cannot accidentally broaden model authority while rendering tools.
#[export]
pub fn authorize_agent_capabilities(
    options: AuthorizeAgentCapabilitiesOptions,
) -> Vec<AgentCapabilityDecision> {
    let granted = options
        .granted_permissions
        .into_iter()
        .map(|permission| normalize_permission(&permission))
        .collect::<BTreeSet<_>>();

    options
        .capabilities
        .into_iter()
        .map(|capability| authorize_capability(capability, &granted))
        .collect()
}

/// Authorize only capabilities present in the application-owned registry.
/// UI shells submit names, never policy metadata, so they cannot weaken a
/// capability's risk class or permission requirements.
#[export]
pub fn authorize_registered_agent_capabilities(
    options: AuthorizeRegisteredAgentCapabilitiesOptions,
) -> Vec<RegisteredAgentCapabilityDecision> {
    let granted = options
        .granted_permissions
        .into_iter()
        .map(|permission| normalize_permission(&permission))
        .collect::<BTreeSet<_>>();
    let manifest = registered_agent_capabilities();

    options
        .names
        .into_iter()
        .map(|name| {
            let Some(capability) = manifest
                .iter()
                .find(|capability| capability.name == name)
                .cloned()
            else {
                return RegisteredAgentCapabilityDecision {
                    name,
                    allowed: false,
                    execution_policy: "denied".to_owned(),
                    reason: "Capability is not registered".to_owned(),
                    risk: "unknown".to_owned(),
                    read_only: false,
                    idempotent: false,
                    open_world: false,
                    required_permissions: vec![],
                };
            };
            let decision = authorize_capability(capability.clone(), &granted);
            RegisteredAgentCapabilityDecision {
                name: decision.name,
                allowed: decision.allowed,
                execution_policy: decision.execution_policy,
                reason: decision.reason,
                risk: capability.risk,
                read_only: capability.read_only,
                idempotent: capability.idempotent,
                open_world: capability.open_world,
                required_permissions: capability.required_permissions,
            }
        })
        .collect()
}

/// Apply a durable agent-task state transition. The platform shell performs
/// browser or native work, while shared Rust code owns legal lifecycle changes
/// and monotonic progress so every UI exposes the same task semantics.
#[export]
pub fn transition_agent_task(options: TransitionAgentTaskOptions) -> AgentTaskTransitionDecision {
    let TransitionAgentTaskOptions { state, event } = options;
    let event_type = normalize_permission(&event.event_type);

    if event_type == "start" {
        if state.status == "running" || state.status == "cancelling" {
            return denied_task_transition(state, "A task is already active");
        }
        let Some(task_id) = non_empty(event.task_id) else {
            return denied_task_transition(state, "Starting a task requires a task id");
        };
        let Some(kind) = non_empty(event.kind) else {
            return denied_task_transition(state, "Starting a task requires a kind");
        };
        return allowed_task_transition(AgentTaskState {
            task_id: Some(task_id),
            kind: Some(kind),
            status: "running".to_owned(),
            progress_basis_points: 0,
            phase: non_empty(event.phase).or_else(|| Some("starting".to_owned())),
            error: None,
        });
    }

    if event_type == "clear" {
        if state.status == "running" || state.status == "cancelling" {
            return denied_task_transition(state, "An active task cannot be cleared");
        }
        return allowed_task_transition(AgentTaskState::default());
    }

    if state.status != "running" && state.status != "cancelling" {
        return denied_task_transition(state, "No task is active");
    }
    if non_empty(event.task_id) != state.task_id {
        return denied_task_transition(state, "Task id does not match the active task");
    }

    match event_type.as_str() {
        "progress" if state.status == "running" => {
            let Some(progress) = event.progress_basis_points else {
                return denied_task_transition(state, "Progress is required");
            };
            if progress > 10_000 {
                return denied_task_transition(state, "Progress exceeds 100 percent");
            }
            if progress < state.progress_basis_points {
                return denied_task_transition(state, "Progress cannot move backwards");
            }
            let mut next = state;
            next.progress_basis_points = progress;
            if let Some(phase) = non_empty(event.phase) {
                next.phase = Some(phase);
            }
            allowed_task_transition(next)
        }
        "request_cancel" if state.status == "running" => {
            let mut next = state;
            next.status = "cancelling".to_owned();
            next.phase = Some("cancelling".to_owned());
            allowed_task_transition(next)
        }
        "complete" if state.status == "running" => {
            let mut next = state;
            next.status = "succeeded".to_owned();
            next.progress_basis_points = 10_000;
            next.phase = non_empty(event.phase).or_else(|| Some("complete".to_owned()));
            next.error = None;
            allowed_task_transition(next)
        }
        "fail" => {
            let Some(error) = non_empty(event.error) else {
                return denied_task_transition(state, "Failure requires an error message");
            };
            let mut next = state;
            next.status = "failed".to_owned();
            next.phase = Some("failed".to_owned());
            next.error = Some(error);
            allowed_task_transition(next)
        }
        "cancel" => {
            let mut next = state;
            next.status = "cancelled".to_owned();
            next.phase = Some("cancelled".to_owned());
            next.error = None;
            allowed_task_transition(next)
        }
        _ => denied_task_transition(state, "Illegal task state transition"),
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

fn allowed_task_transition(state: AgentTaskState) -> AgentTaskTransitionDecision {
    AgentTaskTransitionDecision {
        allowed: true,
        reason: "Task transition accepted".to_owned(),
        state,
    }
}

fn denied_task_transition(state: AgentTaskState, reason: &str) -> AgentTaskTransitionDecision {
    AgentTaskTransitionDecision {
        allowed: false,
        reason: reason.to_owned(),
        state,
    }
}

fn registered_agent_capabilities() -> Vec<AgentCapabilityDescriptor> {
    vec![
        registered_capability("app.get_state", "read", true, true, false, &[]),
        registered_capability("bookmarks.list", "read", true, true, false, &["layers"]),
        registered_capability(
            "captions.get_source",
            "read",
            true,
            true,
            false,
            &["layers"],
        ),
        registered_capability("catalog.get", "read", true, true, false, &[]),
        registered_capability("catalog.list", "read", true, true, false, &[]),
        registered_capability("catalog.search", "read", true, true, false, &[]),
        registered_capability(
            "export.cancel",
            "control",
            false,
            true,
            false,
            &["app_control"],
        ),
        registered_capability("export.get_status", "read", true, true, false, &[]),
        registered_capability("library.search", "read", true, true, false, &["media"]),
        registered_capability(
            "playback.control",
            "control",
            false,
            true,
            false,
            &["app_control"],
        ),
        registered_capability(
            "preview.capture_frame",
            "read",
            true,
            true,
            false,
            &["preview"],
        ),
        registered_capability(
            "preview.capture_range_frames",
            "read",
            true,
            true,
            false,
            &["preview"],
        ),
        registered_capability(
            "scene.activate",
            "control",
            false,
            true,
            false,
            &["app_control"],
        ),
        registered_capability("skills.list", "read", true, true, false, &[]),
        registered_capability("skills.load", "read", true, true, false, &[]),
        registered_capability(
            "timeline.edit_source",
            "edit",
            false,
            false,
            false,
            &["layers"],
        ),
        registered_capability(
            "timeline.edit_full_source",
            "edit",
            false,
            false,
            false,
            &["layers"],
        ),
        registered_capability(
            "timeline.get_element",
            "read",
            true,
            true,
            false,
            &["layers"],
        ),
        registered_capability("timeline.get_layer", "read", true, true, false, &["layers"]),
        registered_capability(
            "timeline.get_visible_state",
            "read",
            true,
            true,
            false,
            &["layers"],
        ),
        registered_capability(
            "timeline.inspect_range",
            "read",
            true,
            true,
            false,
            &["layers"],
        ),
        registered_capability("timeline.list_media", "read", true, true, false, &["media"]),
        registered_capability("timeline.propose_edit_plan", "read", true, true, false, &[]),
        registered_capability(
            "timeline.read_full_source",
            "read",
            true,
            true,
            false,
            &["layers"],
        ),
        registered_capability(
            "timeline.read_source",
            "read",
            true,
            true,
            false,
            &["layers"],
        ),
        registered_capability(
            "timeline.stage_operations",
            "edit",
            false,
            false,
            false,
            &["layers"],
        ),
        registered_capability(
            "timeline.search_elements",
            "read",
            true,
            true,
            false,
            &["layers"],
        ),
        registered_capability(
            "timeline.search_layers",
            "read",
            true,
            true,
            false,
            &["layers"],
        ),
        registered_capability(
            "transcription.cancel",
            "control",
            false,
            true,
            false,
            &["app_control"],
        ),
        registered_capability("transcription.get_status", "read", true, true, false, &[]),
        registered_capability("web.research", "read", true, true, true, &["network"]),
    ]
}

fn registered_capability(
    name: &str,
    risk: &str,
    read_only: bool,
    idempotent: bool,
    open_world: bool,
    required_permissions: &[&str],
) -> AgentCapabilityDescriptor {
    AgentCapabilityDescriptor {
        name: name.to_owned(),
        risk: risk.to_owned(),
        read_only,
        idempotent,
        open_world,
        required_permissions: required_permissions
            .iter()
            .map(|permission| (*permission).to_owned())
            .collect(),
    }
}

fn authorize_capability(
    capability: AgentCapabilityDescriptor,
    granted: &BTreeSet<String>,
) -> AgentCapabilityDecision {
    let missing_permissions = capability
        .required_permissions
        .iter()
        .map(|permission| normalize_permission(permission))
        .filter(|permission| !granted.contains(permission))
        .collect::<Vec<_>>();
    if !missing_permissions.is_empty() {
        return AgentCapabilityDecision {
            name: capability.name,
            allowed: false,
            execution_policy: "denied".to_owned(),
            reason: format!("Missing permission: {}", missing_permissions.join(", ")),
        };
    }

    let risk = normalize_permission(&capability.risk);
    let (allowed, execution_policy, reason) = match risk.as_str() {
        "read" if !capability.read_only => (
            false,
            "denied",
            "Read-risk capability is not declared read-only",
        ),
        "read" if capability.open_world => (
            true,
            "confirm",
            "Open-world reads require an explicit grant and confirmation",
        ),
        "read" => (true, "immediate", "Authorized closed-world read"),
        "control" if capability.idempotent => {
            (true, "immediate", "Authorized idempotent app control")
        }
        "control" => (
            true,
            "review",
            "Non-idempotent app control requires plan review",
        ),
        "edit" => (true, "review", "Project mutation requires plan review"),
        "destructive" => (
            true,
            "confirm",
            "Destructive mutation requires explicit confirmation",
        ),
        "external" => (
            true,
            "confirm",
            "External side effect requires explicit confirmation",
        ),
        _ => (false, "denied", "Unknown capability risk classification"),
    };

    AgentCapabilityDecision {
        name: capability.name,
        allowed,
        execution_policy: execution_policy.to_owned(),
        reason: reason.to_owned(),
    }
}

fn normalize_permission(value: &str) -> String {
    normalize(value).replace(' ', "_")
}

fn score_tool(
    normalized_query: &str,
    query_terms: &BTreeSet<String>,
    tool: &AgentToolDescriptor,
) -> u32 {
    if normalized_query.is_empty() || query_terms.is_empty() {
        return 0;
    }

    let name = normalize(&tool.name);
    let description = normalize(&tool.description);
    let category = normalize(&tool.category);
    let keywords = tool
        .keywords
        .iter()
        .map(|keyword| normalize(keyword))
        .collect::<Vec<_>>();
    let name_terms = terms(&name);
    let description_terms = terms(&description);
    let category_terms = terms(&category);
    let keyword_terms = keywords
        .iter()
        .flat_map(|keyword| terms(keyword))
        .collect::<BTreeSet<_>>();

    let mut score = 0_u32;
    if name == normalized_query {
        score += 240;
    } else if name.contains(normalized_query) {
        score += 100;
    }
    if category == normalized_query {
        score += 80;
    } else if category.contains(normalized_query) {
        score += 35;
    }
    if keywords.iter().any(|keyword| keyword == normalized_query) {
        score += 100;
    }

    for query_term in query_terms {
        if name_terms.contains(query_term) {
            score += 40;
        }
        if keyword_terms.contains(query_term) {
            score += 34;
        }
        if category_terms.contains(query_term) {
            score += 22;
        }
        if description_terms.contains(query_term) {
            score += 10;
        }

        if name_terms
            .iter()
            .any(|term| prefix_matches(query_term, term))
        {
            score += 12;
        }
        if keyword_terms
            .iter()
            .any(|term| prefix_matches(query_term, term))
        {
            score += 10;
        }
    }

    score
}

fn prefix_matches(left: &str, right: &str) -> bool {
    left.len().min(right.len()) >= 4 && (left.starts_with(right) || right.starts_with(left))
}

fn normalize(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut previous_was_separator = true;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character.to_ascii_lowercase());
            previous_was_separator = false;
        } else if !previous_was_separator {
            normalized.push(' ');
            previous_was_separator = true;
        }
    }
    normalized.trim().to_owned()
}

fn terms(value: &str) -> BTreeSet<String> {
    value
        .split_ascii_whitespace()
        .filter(|term| !term.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(
        name: &str,
        description: &str,
        category: &str,
        keywords: &[&str],
    ) -> AgentToolDescriptor {
        AgentToolDescriptor {
            name: name.to_owned(),
            description: description.to_owned(),
            category: category.to_owned(),
            keywords: keywords.iter().map(|value| (*value).to_owned()).collect(),
        }
    }

    #[test]
    fn ranks_names_and_explicit_synonyms_above_description_only_matches() {
        let result = search_agent_tools(SearchAgentToolsOptions {
            query: "remove video background".to_owned(),
            tools: vec![
                tool(
                    "timeline.set_background_removal",
                    "Configure segmentation on a video element",
                    "effects",
                    &["remove background", "person cutout"],
                ),
                tool(
                    "timeline.search_elements",
                    "Search video elements and their background state",
                    "timeline read",
                    &[],
                ),
            ],
            limit: None,
        });

        assert_eq!(result[0].name, "timeline.set_background_removal");
        assert!(result[0].score > result[1].score);
    }

    #[test]
    fn returns_no_results_for_an_empty_query() {
        let result = search_agent_tools(SearchAgentToolsOptions {
            query: "  ".to_owned(),
            tools: vec![tool("timeline.read", "Read timeline", "timeline", &[])],
            limit: None,
        });

        assert!(result.is_empty());
    }

    #[test]
    fn applies_a_bounded_result_limit_and_stable_name_tie_break() {
        let result = search_agent_tools(SearchAgentToolsOptions {
            query: "timeline".to_owned(),
            tools: vec![
                tool("timeline.z", "Timeline", "timeline", &[]),
                tool("timeline.a", "Timeline", "timeline", &[]),
                tool("timeline.b", "Timeline", "timeline", &[]),
            ],
            limit: Some(2),
        });

        assert_eq!(
            result
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["timeline.a", "timeline.b"]
        );
    }

    #[test]
    fn denies_missing_permissions_and_unknown_risk_classes() {
        let decisions = authorize_agent_capabilities(AuthorizeAgentCapabilitiesOptions {
            capabilities: vec![
                AgentCapabilityDescriptor {
                    name: "playback.control".to_owned(),
                    risk: "control".to_owned(),
                    read_only: false,
                    idempotent: true,
                    open_world: false,
                    required_permissions: vec!["app_control".to_owned()],
                },
                AgentCapabilityDescriptor {
                    name: "mystery".to_owned(),
                    risk: "unknown".to_owned(),
                    read_only: true,
                    idempotent: true,
                    open_world: false,
                    required_permissions: vec![],
                },
            ],
            granted_permissions: vec![],
        });

        assert!(!decisions[0].allowed);
        assert_eq!(decisions[0].execution_policy, "denied");
        assert!(!decisions[1].allowed);
    }

    #[test]
    fn maps_risk_classes_to_deterministic_execution_policies() {
        let decisions = authorize_agent_capabilities(AuthorizeAgentCapabilitiesOptions {
            capabilities: vec![
                AgentCapabilityDescriptor {
                    name: "catalog.list".to_owned(),
                    risk: "read".to_owned(),
                    read_only: true,
                    idempotent: true,
                    open_world: false,
                    required_permissions: vec![],
                },
                AgentCapabilityDescriptor {
                    name: "timeline.edit".to_owned(),
                    risk: "edit".to_owned(),
                    read_only: false,
                    idempotent: false,
                    open_world: false,
                    required_permissions: vec!["layers".to_owned()],
                },
                AgentCapabilityDescriptor {
                    name: "selection.advance".to_owned(),
                    risk: "control".to_owned(),
                    read_only: false,
                    idempotent: false,
                    open_world: false,
                    required_permissions: vec!["layers".to_owned()],
                },
                AgentCapabilityDescriptor {
                    name: "media.remove".to_owned(),
                    risk: "destructive".to_owned(),
                    read_only: false,
                    idempotent: false,
                    open_world: false,
                    required_permissions: vec!["media".to_owned()],
                },
            ],
            granted_permissions: vec!["layers".to_owned(), "media".to_owned()],
        });

        assert_eq!(decisions[0].execution_policy, "immediate");
        assert_eq!(decisions[1].execution_policy, "review");
        assert_eq!(decisions[2].execution_policy, "review");
        assert_eq!(decisions[3].execution_policy, "confirm");
        assert!(decisions.iter().all(|decision| decision.allowed));
    }

    #[test]
    fn bounds_range_preview_sampling_to_interior_representative_moments() {
        let short = plan_agent_range_preview_frames(PlanAgentRangePreviewFramesOptions {
            start_time: 0.0,
            end_time: 240_000.0,
            max_frames: None,
        });
        assert!(short.valid);
        assert_eq!(short.times, vec![60_000.0, 180_000.0]);

        let medium = plan_agent_range_preview_frames(PlanAgentRangePreviewFramesOptions {
            start_time: 120_000.0,
            end_time: 1_080_000.0,
            max_frames: None,
        });
        assert_eq!(medium.times, vec![280_000.0, 600_000.0, 920_000.0]);

        let long = plan_agent_range_preview_frames(PlanAgentRangePreviewFramesOptions {
            start_time: 0.0,
            end_time: 2_400_000.0,
            max_frames: None,
        });
        assert_eq!(
            long.times,
            vec![300_000.0, 900_000.0, 1_500_000.0, 2_100_000.0]
        );

        let capped = plan_agent_range_preview_frames(PlanAgentRangePreviewFramesOptions {
            start_time: 0.0,
            end_time: 2_400_000.0,
            max_frames: Some(2),
        });
        assert_eq!(capped.times, vec![600_000.0, 1_800_000.0]);

        let invalid = plan_agent_range_preview_frames(PlanAgentRangePreviewFramesOptions {
            start_time: 42.5,
            end_time: 42.0,
            max_frames: None,
        });
        assert!(!invalid.valid);
        assert!(invalid.times.is_empty());
        assert!(invalid.reason.is_some());
    }

    #[test]
    fn range_preview_frames_require_the_preview_grant() {
        let denied =
            authorize_registered_agent_capabilities(AuthorizeRegisteredAgentCapabilitiesOptions {
                names: vec!["preview.capture_range_frames".to_owned()],
                granted_permissions: vec![],
            });
        assert!(!denied[0].allowed);
        assert_eq!(denied[0].required_permissions, vec!["preview"]);

        let allowed =
            authorize_registered_agent_capabilities(AuthorizeRegisteredAgentCapabilitiesOptions {
                names: vec!["preview.capture_range_frames".to_owned()],
                granted_permissions: vec!["preview".to_owned()],
            });
        assert!(allowed[0].allowed);
        assert_eq!(allowed[0].execution_policy, "immediate");
        assert!(allowed[0].read_only);
        assert!(allowed[0].idempotent);
    }

    #[test]
    fn registered_manifest_is_authoritative_and_fail_closed() {
        let decisions =
            authorize_registered_agent_capabilities(AuthorizeRegisteredAgentCapabilitiesOptions {
                names: vec![
                    "app.get_state".to_owned(),
                    "playback.control".to_owned(),
                    "timeline.edit_source".to_owned(),
                    "timeline.edit_full_source".to_owned(),
                    "timeline.read_full_source".to_owned(),
                    "app.invoke_action".to_owned(),
                    "web.research".to_owned(),
                ],
                granted_permissions: vec!["layers".to_owned()],
            });

        assert!(decisions[0].allowed);
        assert_eq!(decisions[0].execution_policy, "immediate");
        assert!(!decisions[1].allowed);
        assert_eq!(decisions[1].required_permissions, vec!["app_control"]);
        assert!(decisions[2].allowed);
        assert_eq!(decisions[2].execution_policy, "review");
        assert!(decisions[3].allowed);
        assert_eq!(decisions[3].execution_policy, "review");
        assert_eq!(decisions[3].risk, "edit");
        assert!(decisions[4].allowed);
        assert_eq!(decisions[4].execution_policy, "immediate");
        assert!(decisions[4].read_only);
        assert!(!decisions[5].allowed);
        assert_eq!(decisions[5].risk, "unknown");
        assert!(!decisions[6].allowed);
        assert_eq!(decisions[6].required_permissions, vec!["network"]);

        let web =
            authorize_registered_agent_capabilities(AuthorizeRegisteredAgentCapabilitiesOptions {
                names: vec!["web.research".to_owned()],
                granted_permissions: vec!["network".to_owned()],
            });
        assert!(web[0].allowed);
        assert_eq!(web[0].execution_policy, "confirm");
        assert!(web[0].open_world);
    }

    #[test]
    fn task_lifecycle_enforces_identity_and_monotonic_progress() {
        let started = transition_agent_task(TransitionAgentTaskOptions {
            state: AgentTaskState::default(),
            event: AgentTaskEvent {
                event_type: "start".to_owned(),
                task_id: Some("task-1".to_owned()),
                kind: Some("transcription".to_owned()),
                progress_basis_points: None,
                phase: Some("extracting_audio".to_owned()),
                error: None,
            },
        });
        assert!(started.allowed);
        assert_eq!(started.state.status, "running");

        let progressed = transition_agent_task(TransitionAgentTaskOptions {
            state: started.state.clone(),
            event: AgentTaskEvent {
                event_type: "progress".to_owned(),
                task_id: Some("task-1".to_owned()),
                kind: None,
                progress_basis_points: Some(2_500),
                phase: Some("transcribing".to_owned()),
                error: None,
            },
        });
        assert!(progressed.allowed);
        assert_eq!(progressed.state.progress_basis_points, 2_500);

        let backwards = transition_agent_task(TransitionAgentTaskOptions {
            state: progressed.state.clone(),
            event: AgentTaskEvent {
                event_type: "progress".to_owned(),
                task_id: Some("task-1".to_owned()),
                kind: None,
                progress_basis_points: Some(2_000),
                phase: None,
                error: None,
            },
        });
        assert!(!backwards.allowed);
        assert_eq!(backwards.state, progressed.state);

        let wrong_task = transition_agent_task(TransitionAgentTaskOptions {
            state: progressed.state,
            event: AgentTaskEvent {
                event_type: "complete".to_owned(),
                task_id: Some("task-2".to_owned()),
                kind: None,
                progress_basis_points: None,
                phase: None,
                error: None,
            },
        });
        assert!(!wrong_task.allowed);
        assert_eq!(wrong_task.state.status, "running");
    }

    #[test]
    fn task_cancellation_is_idempotent_at_the_control_boundary() {
        let started = transition_agent_task(TransitionAgentTaskOptions {
            state: AgentTaskState::default(),
            event: AgentTaskEvent {
                event_type: "start".to_owned(),
                task_id: Some("task-1".to_owned()),
                kind: Some("export".to_owned()),
                progress_basis_points: None,
                phase: None,
                error: None,
            },
        });
        let cancelling = transition_agent_task(TransitionAgentTaskOptions {
            state: started.state,
            event: AgentTaskEvent {
                event_type: "request_cancel".to_owned(),
                task_id: Some("task-1".to_owned()),
                kind: None,
                progress_basis_points: None,
                phase: None,
                error: None,
            },
        });
        assert!(cancelling.allowed);
        assert_eq!(cancelling.state.status, "cancelling");

        let cancelled = transition_agent_task(TransitionAgentTaskOptions {
            state: cancelling.state,
            event: AgentTaskEvent {
                event_type: "cancel".to_owned(),
                task_id: Some("task-1".to_owned()),
                kind: None,
                progress_basis_points: None,
                phase: None,
                error: None,
            },
        });
        assert!(cancelled.allowed);
        assert_eq!(cancelled.state.status, "cancelled");
    }
}
