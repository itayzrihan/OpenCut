use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path as AxumPath, Request, State},
    http::{StatusCode, header::AUTHORIZATION},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use opencut_editor_api::{
    AccessLevel, ArtifactRef, ArtifactStore, CapabilityDescriptor, CapabilityError,
    CapabilityResult, FnCapability, InvocationContext, OpenCutRuntime,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

const BRIDGE_BODY_LIMIT: usize = 32 * 1024 * 1024;

const SESSION_RESOURCE: &str = "opencut://classic/session";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(45);
const SESSION_STALE_AFTER_MS: u64 = 10_000;
const SESSION_COMMAND_STALE_AFTER_MS: u64 = 120_000;
const STATIC_CAPABILITY_IDS: [&str; 2] = ["classic.session.read", "classic.tool.invoke"];

/// Browser registry projection must not turn the editor MCP endpoint into a
/// machine-control endpoint or grant its caller the internal agent's policy.
fn internal_agent_tool_reason(tool_name: &str) -> Option<&'static str> {
    let id = tool_name.strip_prefix("canonical.")?;
    (id.starts_with("computer.") || id.starts_with("agent.policy.")).then_some(
        "Computer operations and agent permissions are only available through the internal editor's user-controlled agent session",
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassicToolDescriptor {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub idempotent: bool,
    #[serde(default)]
    pub open_world: bool,
    #[serde(default)]
    pub risk: Option<String>,
    /// Exact canonical descriptor published by the browser runtime, not a handwritten tool.
    #[serde(default)]
    pub canonical: Option<CapabilityDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassicSessionSnapshot {
    pub session_id: String,
    pub project_id: String,
    pub project_name: String,
    pub revision: u64,
    #[serde(default)]
    pub canonical_revision: Option<u64>,
    pub dirty: bool,
    pub playback: Value,
    pub timeline: Value,
    pub selection: Value,
    pub ui: Value,
    #[serde(default)]
    pub tools: Vec<ClassicToolDescriptor>,
    #[serde(default)]
    pub updated_at_ms: u64,
}

/// Transport liveness/UI metadata only; never a second editor document.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClassicHeartbeat {
    project_id: String,
    project_name: String,
    expected_revision: u64,
    revision: u64,
    #[serde(default)]
    canonical_revision: Option<u64>,
    dirty: bool,
    playback: Value,
    selection: Value,
    ui: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClassicCommand {
    id: String,
    session_id: String,
    project_id: String,
    tool_name: String,
    arguments: Value,
    auto_apply: bool,
    #[serde(default)]
    context: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeArtifact { metadata: ArtifactRef, data_base64: String }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassicCommandCompletion {
    command_id: String,
    ok: bool,
    #[serde(default)]
    output: Value,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    applied: bool,
    #[serde(default)]
    revision: Option<u64>,
    #[serde(default)]
    artifacts: Vec<BridgeArtifact>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandBatch {
    commands: Vec<ClassicCommand>,
    cancelled_command_ids: Vec<String>,
}

#[derive(Default)]
struct CommandState {
    queue: VecDeque<ClassicCommand>,
    cancellations: HashMap<String, Vec<String>>,
    waiters: HashMap<String, (String, bool, oneshot::Sender<ClassicCommandCompletion>)>,
}

struct ClassicBridgeInner {
    runtime: OpenCutRuntime,
    artifacts: ArtifactStore,
    sessions: RwLock<HashMap<String, ClassicSessionSnapshot>>,
    active_session_id: RwLock<Option<String>>,
    command_state: Mutex<CommandState>,
    dynamic_signatures: Mutex<BTreeMap<String, String>>,
    next_command_id: AtomicU64,
}

#[derive(Clone)]
pub struct ClassicBridge {
    inner: Arc<ClassicBridgeInner>,
}

impl ClassicBridge {
    pub fn register(runtime: &OpenCutRuntime) -> Result<Self, String> {
        let bridge = Self {
            inner: Arc::new(ClassicBridgeInner {
                runtime: runtime.clone(),
                artifacts: runtime.artifacts().clone(),
                sessions: RwLock::new(HashMap::new()),
                active_session_id: RwLock::new(None),
                command_state: Mutex::new(CommandState::default()),
                dynamic_signatures: Mutex::new(BTreeMap::new()),
                next_command_id: AtomicU64::new(1),
            }),
        };
        bridge.register_static_capabilities()?;
        Ok(bridge)
    }

    fn register_static_capabilities(&self) -> Result<(), String> {
        let read_bridge = self.clone();
        self.inner
            .runtime
            .register(Arc::new(FnCapability::new(
                CapabilityDescriptor::read(
                    "classic.session.read",
                    "Read live Classic editor session",
                    "Reads the project, playhead, timeline, selection, semantic UI snapshot, and dynamically exposed capabilities from the connected OpenCut browser editor.",
                    "classic",
                    json!({
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false
                    }),
                    json!({
                        "type": "object",
                        "properties": {
                            "connected": {"type": "boolean"},
                            "session": {"type": ["object", "null"]},
                            "sessions": {
                                "type": "array",
                                "description": "All OpenCut browser tabs currently known to this authenticated MCP instance.",
                                "items": {"type": "object"}
                            }
                        },
                        "required": ["connected", "session", "sessions"],
                        "additionalProperties": false
                    }),
                ),
                move |_, _| {
                    let bridge = read_bridge.clone();
                    Box::pin(async move { Ok(CapabilityResult::data(bridge.session_value())) })
                },
            )))
            .map_err(|error| error.to_string())?;

        let invoke_bridge = self.clone();
        let mut descriptor = CapabilityDescriptor::read(
            "classic.tool.invoke",
            "Invoke live Classic editor capability",
            "Late-bound invocation surface for any capability advertised by the connected OpenCut browser editor.",
            "classic",
            json!({
                "type": "object",
                "properties": {
                    "toolName": {"type": "string", "minLength": 1},
                    "arguments": {"type": "object"},
                    "browserSessionId": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Target one exact OpenCut browser tab returned by classic.session.read."
                    },
                    "autoApply": {
                        "type": "boolean",
                        "default": true,
                        "description": "Apply a validated staged edit plan immediately through the browser editor command history."
                    }
                },
                "required": ["toolName"],
                "additionalProperties": false
            }),
            command_output_schema(),
        );
        descriptor.access = AccessLevel::Admin;
        descriptor.idempotent = false;
        descriptor.cancellable = true;
        descriptor.tags = vec!["browser".into(), "live".into(), "late-bound".into()];
        self.inner
            .runtime
            .register(Arc::new(FnCapability::new(
                descriptor,
                move |context, input| {
                    let bridge = invoke_bridge.clone();
                    Box::pin(async move {
                        let tool_name = input
                            .get("toolName")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput("toolName is required".into())
                            })?
                            .to_owned();
                        let arguments =
                            input.get("arguments").cloned().unwrap_or_else(|| json!({}));
                        let auto_apply = input
                            .get("autoApply")
                            .and_then(Value::as_bool)
                            .unwrap_or(true);
                        let browser_session_id = input
                            .get("browserSessionId")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        bridge
                            .invoke_browser_tool(
                                context,
                                tool_name,
                                arguments,
                                auto_apply,
                                browser_session_id,
                            )
                            .await
                    })
                },
            )))
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn session_value(&self) -> Value {
        let session = self.select_session(None, None);
        let connected = session
            .as_ref()
            .is_some_and(|snapshot| !is_session_stale(snapshot));
        let active_session_id = session
            .as_ref()
            .map(|snapshot| snapshot.session_id.as_str());
        let sessions = self
            .inner
            .sessions
            .read()
            .map(|sessions| {
                let mut summaries = sessions
                    .values()
                    .map(|snapshot| {
                        json!({
                            "sessionId": snapshot.session_id,
                            "projectId": snapshot.project_id,
                            "projectName": snapshot.project_name,
                            "revision": snapshot.revision,
                            "canonicalRevision": snapshot.canonical_revision,
                            "dirty": snapshot.dirty,
                            "connected": !is_session_stale(snapshot),
                            "active": active_session_id == Some(snapshot.session_id.as_str()),
                            "playback": snapshot.playback,
                            "ui": snapshot.ui,
                            "updatedAtMs": snapshot.updated_at_ms
                        })
                    })
                    .collect::<Vec<_>>();
                summaries.sort_by_key(|summary| {
                    std::cmp::Reverse(
                        summary
                            .get("updatedAtMs")
                            .and_then(Value::as_u64)
                            .unwrap_or_default(),
                    )
                });
                summaries
            })
            .unwrap_or_default();
        json!({
            "connected": connected,
            "session": session,
            "sessions": sessions
        })
    }

    fn update_session(&self, mut snapshot: ClassicSessionSnapshot) -> Result<usize, String> {
        if snapshot.session_id.trim().is_empty()
            || snapshot.project_id.trim().is_empty()
            || snapshot.project_name.trim().is_empty()
        {
            return Err("sessionId, projectId, and projectName are required".into());
        }
        // Do not trust a browser's availability claim for internal-only tools.
        // Keep the same restriction visible in session discovery and schemas.
        for tool in &mut snapshot.tools {
            if let Some(reason) = internal_agent_tool_reason(&tool.name)
                && let Some(canonical) = &mut tool.canonical
            {
                canonical.available = false;
                canonical.unavailable_reason = Some(reason.into());
            }
        }
        snapshot.updated_at_ms = now_ms();
        let tools = snapshot.tools.clone();
        let session_id = snapshot.session_id.clone();
        let candidate_is_visible = snapshot_is_visible(&snapshot);
        let candidate_is_focused = snapshot_is_focused(&snapshot);
        let candidate_last_active_at_ms = snapshot_last_active_at_ms(&snapshot);
        self.inner
            .sessions
            .write()
            .map_err(|_| "classic session lock was poisoned")?
            .insert(session_id.clone(), snapshot);
        self.update_active_session(
            &session_id,
            candidate_is_visible,
            candidate_is_focused,
            candidate_last_active_at_ms,
        )?;
        let all_tools = self.all_session_tools();
        self.sync_dynamic_capabilities(&all_tools)?;
        self.inner
            .runtime
            .registry()
            .notify_resources_changed(vec![SESSION_RESOURCE.into()])
            .map_err(|error| error.to_string())?;
        Ok(tools.len())
    }

    fn update_active_session(
        &self,
        session_id: &str,
        candidate_is_visible: bool,
        candidate_is_focused: bool,
        candidate_last_active_at_ms: u64,
    ) -> Result<(), String> {
        let current_id = self
            .inner
            .active_session_id
            .read()
            .map_err(|_| "classic active session lock was poisoned")?
            .clone();
        let should_activate = match current_id.as_deref() {
            None => true,
            Some(current_id) if current_id == session_id => false,
            Some(current_id) => self
                .inner
                .sessions
                .read()
                .map_err(|_| "classic session lock was poisoned")?
                .get(current_id)
                .is_none_or(|current| {
                    is_session_stale(current)
                        || (candidate_is_visible
                            && (!snapshot_is_visible(current) || candidate_is_focused))
                        || candidate_last_active_at_ms > snapshot_last_active_at_ms(current)
                }),
        };
        if should_activate {
            *self
                .inner
                .active_session_id
                .write()
                .map_err(|_| "classic active session lock was poisoned")? =
                Some(session_id.to_owned());
        }
        Ok(())
    }

    fn update_heartbeat(
        &self,
        session_id: &str,
        heartbeat: ClassicHeartbeat,
    ) -> Result<(), String> {
        let activity = {
            let mut sessions = self
                .inner
                .sessions
                .write()
                .map_err(|_| "classic session lock was poisoned")?;
            let snapshot = sessions
                .get_mut(session_id)
                .ok_or("Full snapshot required")?;
            if snapshot.project_id != heartbeat.project_id
                || snapshot.revision != heartbeat.expected_revision
                || heartbeat.revision < heartbeat.expected_revision
            {
                return Err("Full snapshot required".into());
            }
            snapshot.project_name = heartbeat.project_name;
            snapshot.revision = heartbeat.revision;
            snapshot.canonical_revision = heartbeat.canonical_revision;
            snapshot.dirty = heartbeat.dirty;
            snapshot.playback = heartbeat.playback;
            snapshot.selection = heartbeat.selection;
            snapshot.ui = heartbeat.ui;
            snapshot.updated_at_ms = now_ms();
            (
                snapshot_is_visible(snapshot),
                snapshot_is_focused(snapshot),
                snapshot_last_active_at_ms(snapshot),
            )
        };
        self.update_active_session(session_id, activity.0, activity.1, activity.2)?;
        self.inner
            .runtime
            .registry()
            .notify_resources_changed(vec![SESSION_RESOURCE.into()])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn disconnect(&self, session_id: &str) {
        let removed = self
            .inner
            .sessions
            .write()
            .ok()
            .and_then(|mut sessions| sessions.remove(session_id));
        if removed.is_none() {
            return;
        }
        if let Ok(mut active_session_id) = self.inner.active_session_id.write()
            && active_session_id.as_deref() == Some(session_id)
        {
            *active_session_id = self.inner.sessions.read().ok().and_then(|sessions| {
                sessions
                    .values()
                    .filter(|snapshot| !is_session_stale(snapshot))
                    .max_by_key(|snapshot| snapshot.updated_at_ms)
                    .map(|snapshot| snapshot.session_id.clone())
            });
        }
        if let Ok(mut commands) = self.inner.command_state.lock() {
            commands.cancellations.remove(session_id);
            commands
                .queue
                .retain(|command| command.session_id != session_id);
            let waiter_ids: Vec<_> = commands
                .waiters
                .iter()
                .filter(|(_, (owner, _, _))| owner == session_id)
                .map(|(id, _)| id.clone())
                .collect();
            for command_id in waiter_ids {
                if let Some((_, _, waiter)) = commands.waiters.remove(&command_id) {
                    let _ = waiter.send(ClassicCommandCompletion {
                        command_id,
                        ok: false,
                        output: Value::Null,
                        error: Some("OpenCut browser session disconnected".into()),
                        applied: false,
                        revision: None,
                        artifacts: Vec::new(),
                    });
                }
            }
        }
        let all_tools = self.all_session_tools();
        if all_tools.is_empty() {
            self.remove_dynamic_capabilities();
        } else {
            let _ = self.sync_dynamic_capabilities(&all_tools);
        }
        let _ = self
            .inner
            .runtime
            .registry()
            .notify_resources_changed(vec![SESSION_RESOURCE.into()]);
    }

    fn all_session_tools(&self) -> Vec<ClassicToolDescriptor> {
        let Ok(sessions) = self.inner.sessions.read() else {
            return Vec::new();
        };
        let mut tools = BTreeMap::new();
        for snapshot in sessions.values() {
            for tool in &snapshot.tools {
                tools.insert(tool.name.clone(), tool.clone());
            }
        }
        tools.into_values().collect()
    }

    fn select_session(
        &self,
        project_id: Option<&str>,
        browser_session_id: Option<&str>,
    ) -> Option<ClassicSessionSnapshot> {
        let sessions = self.inner.sessions.read().ok()?;
        if let Some(browser_session_id) = browser_session_id {
            return sessions
                .get(browser_session_id)
                .filter(|snapshot| {
                    project_id.is_none_or(|project_id| snapshot.project_id == project_id)
                })
                .cloned();
        }
        let active_session_id = self
            .inner
            .active_session_id
            .read()
            .ok()
            .and_then(|session_id| session_id.clone());
        let project_matches = |snapshot: &&ClassicSessionSnapshot| {
            project_id.is_none_or(|project_id| snapshot.project_id == project_id)
        };
        if let Some(ref active_session_id) = active_session_id
            && let Some(snapshot) = sessions.get(active_session_id)
            && project_id.is_none_or(|project_id| snapshot.project_id == project_id)
            && !is_session_stale(snapshot)
        {
            return Some(snapshot.clone());
        }

        sessions
            .values()
            .filter(project_matches)
            .filter(|snapshot| !is_session_stale(snapshot))
            .max_by_key(|snapshot| {
                (
                    snapshot_is_focused(snapshot),
                    snapshot_is_visible(snapshot),
                    snapshot_last_active_at_ms(snapshot),
                    snapshot.updated_at_ms,
                )
            })
            .or_else(|| {
                active_session_id
                    .as_deref()
                    .and_then(|session_id| sessions.get(session_id))
                    .filter(|snapshot| {
                        project_id.is_none_or(|project_id| snapshot.project_id == project_id)
                    })
            })
            .or_else(|| {
                sessions
                    .values()
                    .filter(project_matches)
                    .max_by_key(|snapshot| snapshot.updated_at_ms)
            })
            .cloned()
    }

    fn sync_dynamic_capabilities(&self, tools: &[ClassicToolDescriptor]) -> Result<(), String> {
        let desired: BTreeMap<String, (String, ClassicToolDescriptor)> = tools
            .iter()
            .filter_map(|tool| {
                let id = classic_capability_id(&tool.name)?;
                if STATIC_CAPABILITY_IDS.contains(&id.as_str()) {
                    return None;
                }
                let signature = serde_json::to_string(tool).ok()?;
                Some((id, (signature, tool.clone())))
            })
            .collect();
        let current = self
            .inner
            .dynamic_signatures
            .lock()
            .map_err(|_| "classic capability signature lock was poisoned")?
            .clone();

        for id in current.keys().filter(|id| !desired.contains_key(*id)) {
            self.inner
                .runtime
                .registry()
                .unregister(id)
                .map_err(|error| error.to_string())?;
        }
        for (id, (signature, tool)) in &desired {
            if current.get(id) == Some(signature) {
                continue;
            }
            if current.contains_key(id) {
                self.inner
                    .runtime
                    .registry()
                    .unregister(id)
                    .map_err(|error| error.to_string())?;
            }
            self.register_dynamic_capability(id.clone(), tool.clone())?;
        }
        *self
            .inner
            .dynamic_signatures
            .lock()
            .map_err(|_| "classic capability signature lock was poisoned")? = desired
            .into_iter()
            .map(|(id, (signature, _))| (id, signature))
            .collect();
        Ok(())
    }

    fn remove_dynamic_capabilities(&self) {
        let ids = self
            .inner
            .dynamic_signatures
            .lock()
            .map(|mut signatures| std::mem::take(&mut *signatures))
            .unwrap_or_default();
        for id in ids.keys() {
            let _ = self.inner.runtime.registry().unregister(id);
        }
    }

    fn register_dynamic_capability(
        &self,
        id: String,
        tool: ClassicToolDescriptor,
    ) -> Result<(), String> {
        let access = tool.canonical.as_ref().map_or_else(|| tool_access(&tool), |d| d.access);
        let mut input_schema = tool.parameters.clone();
        if input_schema.get("type").and_then(Value::as_str) != Some("object") {
            input_schema = json!({
                "type": "object",
                "properties": {},
                "additionalProperties": true
            });
        }
        if input_schema
            .get("properties")
            .and_then(Value::as_object)
            .is_none()
        {
            input_schema["properties"] = json!({});
        }
        if let Some(properties) = input_schema
            .get_mut("properties")
            .and_then(Value::as_object_mut)
        {
            properties.insert(
                "browserSessionId".into(),
                json!({
                    "type": "string",
                    "minLength": 1,
                    "description": "Target one exact OpenCut browser tab returned by classic.session.read."
                }),
            );
        }
        let mut descriptor = CapabilityDescriptor::read(
            id,
            tool.name.clone(),
            tool.description.clone(),
            tool.category.clone().unwrap_or_else(|| "classic".into()),
            input_schema,
            command_output_schema(),
        );
        if let Some(canonical) = &tool.canonical {
            if tool.name != format!("canonical.{}", canonical.id) || tool.parameters != canonical.input_schema {
                return Err("Canonical browser tool must match its registry descriptor".into());
            }
            descriptor.title = canonical.title.clone();
            descriptor.version = canonical.version.clone();
            descriptor.available = canonical.available;
            descriptor.unavailable_reason = canonical.unavailable_reason.clone();
            descriptor.supports_dry_run = canonical.supports_dry_run;
            descriptor.document_support = opencut_editor_api::DocumentSupport::Both;
            descriptor.output_schema["properties"]["output"] = canonical.output_schema.clone();
            // Local JSON Schema references still resolve from the wrapper root.
            if let Some(definitions) = canonical.output_schema.get("$defs") {
                descriptor.output_schema["$defs"] = definitions.clone();
            }
        }
        descriptor.access = access;
        descriptor.idempotent = tool.canonical.as_ref().map_or(tool.idempotent, |d| d.idempotent);
        descriptor.open_world = tool.canonical.as_ref().map_or(tool.open_world, |d| d.open_world);
        descriptor.cancellable = tool.canonical.as_ref().map_or(true, |d| d.cancellable);
        if let Some(reason) = internal_agent_tool_reason(&tool.name) {
            descriptor.available = false;
            descriptor.unavailable_reason = Some(reason.into());
        }
        // Cross-process invocation cannot participate in a native transaction.
        descriptor.transactional = false;
        descriptor.tags = {
            let mut tags = vec!["classic".into(), "browser".into(), "live".into()];
            tags.extend(tool.keywords.clone());
            tags
        };

        let bridge = self.clone();
        let tool_name = tool.name;
        self.inner
            .runtime
            .register(Arc::new(FnCapability::new(
                descriptor,
                move |context, mut input| {
                    let bridge = bridge.clone();
                    let tool_name = tool_name.clone();
                    let browser_session_id = input
                        .get("browserSessionId")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    if let Some(arguments) = input.as_object_mut() {
                        arguments.remove("browserSessionId");
                    }
                    Box::pin(async move {
                        bridge
                            .invoke_browser_tool(
                                context,
                                tool_name,
                                input,
                                access != AccessLevel::Read,
                                browser_session_id,
                            )
                            .await
                    })
                },
            )))
            .map_err(|error| error.to_string())
    }

    async fn invoke_browser_tool(
        &self,
        context: InvocationContext,
        tool_name: String,
        arguments: Value,
        auto_apply: bool,
        browser_session_id: Option<String>,
    ) -> Result<CapabilityResult, CapabilityError> {
        // Recheck the name at execution, including classic.tool.invoke. This
        // remains authoritative if discovery is stale or metadata is missing.
        if let Some(reason) = internal_agent_tool_reason(&tool_name) {
            return Err(CapabilityError::Unavailable(reason.into()));
        }
        let targeted_project_id = arguments.get("projectId").and_then(Value::as_str).or_else(|| context
            .metadata.get("opencut/projectId").and_then(Value::as_str));
        let snapshot = self
            .select_session(targeted_project_id, browser_session_id.as_deref())
            .ok_or_else(|| {
                CapabilityError::Unavailable("no OpenCut browser project is connected".into())
            })?;
        if is_session_too_stale_for_command(&snapshot) {
            return Err(CapabilityError::Unavailable(
                "the OpenCut browser session stopped sending heartbeats".into(),
            ));
        }
        let canonical = tool_name.starts_with("canonical.");
        let actual_revision = if canonical { snapshot.canonical_revision } else { Some(snapshot.revision) };
        if let Some(expected_revision) = arguments.get("expectedRevision").and_then(Value::as_u64).or_else(|| context
            .metadata
            .get("opencut/expectedRevision")
            .and_then(Value::as_u64))
            && !(canonical && context.metadata.get("opencut/idempotencyKey").and_then(Value::as_str).is_some())
            && Some(expected_revision) != actual_revision
        {
            return Err(CapabilityError::Conflict(format!(
                "expected browser revision {expected_revision}, current revision is {actual_revision:?}"
            )));
        }
        let advertised = snapshot.tools.iter().find(|tool| tool.name == tool_name);
        if advertised.is_none() {
            return Err(CapabilityError::Unavailable(format!(
                "the connected browser does not advertise `{tool_name}`"
            )));
        }

        if advertised.and_then(|tool| tool.canonical.as_ref()).is_some_and(|descriptor| !descriptor.available) {
            return Err(CapabilityError::Unavailable("The browser host cannot execute this canonical capability".into()));
        }

        let command_id = format!(
            "classic-command-{}-{}",
            now_ms(),
            self.inner.next_command_id.fetch_add(1, Ordering::Relaxed)
        );
        let command = ClassicCommand {
            id: command_id.clone(),
            session_id: snapshot.session_id.clone(),
            project_id: snapshot.project_id.clone(),
            tool_name,
            arguments,
            auto_apply,
            context: json!({"dryRun":context.dry_run,"requestId":context.request_id.as_deref().unwrap_or(&command_id),"metadata":context.metadata}),
        };
        let (sender, receiver) = oneshot::channel();
        {
            let mut state =
                self.inner.command_state.lock().map_err(|_| {
                    CapabilityError::Failed("classic command lock was poisoned".into())
                })?;
            state
                .waiters
                .insert(command_id.clone(), (snapshot.session_id.clone(), canonical, sender));
            state.queue.push_back(command);
        }

        let completion = tokio::select! {
            result = receiver => result.map_err(|_| {
                CapabilityError::Failed("the browser command result channel closed".into())
            })?,
            _ = context.cancellation.cancelled() => {
                self.abandon_command(&command_id);
                return Err(CapabilityError::Failed("browser command was cancelled".into()));
            },
            _ = tokio::time::sleep(if canonical { Duration::from_secs(240) } else { COMMAND_TIMEOUT }) => {
                self.abandon_command(&command_id);
                return Err(CapabilityError::Unavailable(
                    "the OpenCut browser did not answer before the command deadline; reconcile an uncertain write using its original idempotency key".into(),
                ));
            }
        };
        if !completion.ok {
            return Err(CapabilityError::Failed(
                completion
                    .error
                    .unwrap_or_else(|| "the browser command failed".into()),
            ));
        }

        let mut output = completion.output;
        let mut artifacts = import_browser_artifacts(&mut output, completion.artifacts, &self.inner.artifacts)?;
        collect_data_url_artifacts(&mut output, &self.inner.artifacts, &mut artifacts);
        Ok(CapabilityResult {
            data: json!({
                "output": output,
                "applied": completion.applied,
                "revision": completion.revision
            }),
            summary: Some(format!(
                "Executed live browser command {}",
                completion.command_id
            )),
            changed_resources: if completion.applied {
                vec![SESSION_RESOURCE.into()]
            } else {
                Vec::new()
            },
            artifacts,
        })
    }

    fn abandon_command(&self, command_id: &str) {
        if let Ok(mut state) = self.inner.command_state.lock() {
            state.queue.retain(|command| command.id != command_id);
            if let Some((session, _, _)) = state.waiters.remove(command_id) {
                state.cancellations.entry(session).or_default().push(command_id.to_owned());
            }
        }
    }

    fn take_commands(&self, session_id: &str) -> Vec<ClassicCommand> {
        let Ok(mut state) = self.inner.command_state.lock() else {
            return Vec::new();
        };
        let mut selected = Vec::new();
        let mut remaining = VecDeque::new();
        while let Some(command) = state.queue.pop_front() {
            if command.session_id == session_id {
                selected.push(command);
            } else {
                remaining.push_back(command);
            }
        }
        state.queue = remaining;
        selected
    }

    fn complete_command(&self, session_id: &str, completion: ClassicCommandCompletion) -> bool {
        let session_matches = self
            .inner
            .sessions
            .read()
            .ok()
            .is_some_and(|sessions| sessions.contains_key(session_id));
        if !session_matches {
            return false;
        }
        self.inner
            .command_state
            .lock()
            .ok()
            .and_then(|mut state| {
                if state
                    .waiters
                    .get(&completion.command_id)
                    .is_some_and(|(owner, _, _)| owner == session_id)
                {
                    state.waiters.remove(&completion.command_id)
                } else {
                    None
                }
            })
            .is_some_and(|(_, canonical, waiter)| {
                if canonical && completion.ok {
                    if let Ok(mut sessions) = self.inner.sessions.write() {
                        if let Some(snapshot) = sessions.get_mut(session_id) {
                            snapshot.canonical_revision = completion.revision;
                        }
                    }
                }
                waiter.send(completion).is_ok()
            })
    }
}

#[derive(Clone)]
struct BridgeHttpState {
    bridge: ClassicBridge,
    expected_token: Arc<str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStatus {
    healthy: bool,
    supports_canonical_invocation: bool,
    connected: bool,
    session_id: Option<String>,
    project_id: Option<String>,
    project_name: Option<String>,
    revision: Option<u64>,
}

pub struct ClassicBridgeServer {
    address: SocketAddr,
    config_path: PathBuf,
    instance_config_path: PathBuf,
    token: String,
    task: JoinHandle<()>,
}

impl ClassicBridgeServer {
    pub fn address(&self) -> SocketAddr {
        self.address
    }
}

impl Drop for ClassicBridgeServer {
    fn drop(&mut self) {
        self.task.abort();
        remove_bridge_config_if_owned(&self.instance_config_path, &self.token);
        remove_bridge_config_if_owned(&self.config_path, &self.token);
    }
}

fn remove_bridge_config_if_owned(path: &Path, token: &str) {
    let should_remove = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("token")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|config_token| config_token == token);
    if should_remove {
        let _ = std::fs::remove_file(path);
    }
}

pub async fn spawn_classic_bridge(
    runtime: &OpenCutRuntime,
    address: SocketAddr,
    config_path: impl Into<PathBuf>,
) -> Result<ClassicBridgeServer, Box<dyn std::error::Error>> {
    if !address.ip().is_loopback() {
        return Err("OpenCut Classic bridge must bind to a loopback address".into());
    }
    let mut token_bytes = [0_u8; 48];
    getrandom::fill(&mut token_bytes).map_err(|error| std::io::Error::other(error.to_string()))?;
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token_bytes);
    let bridge = ClassicBridge::register(runtime)?;
    let listener = TcpListener::bind(address).await?;
    let address = listener.local_addr()?;
    let config_path = config_path.into();
    let instance_config_path = bridge_instance_config_path(&config_path);
    write_bridge_config(&instance_config_path, address, &token)?;
    write_bridge_config(&config_path, address, &token)?;

    let state = BridgeHttpState {
        bridge,
        expected_token: Arc::from(token.clone()),
    };
    let app = Router::new()
        .route("/bridge/status", get(bridge_status))
        .route("/bridge/state", put(update_bridge_state))
        .route(
            "/bridge/heartbeat/{session_id}",
            post(update_bridge_heartbeat).layer(DefaultBodyLimit::max(512 * 1024)),
        )
        .route("/bridge/commands/{session_id}", get(poll_bridge_commands))
        .route(
            "/bridge/results/{session_id}",
            post(complete_bridge_command),
        )
        .route(
            "/bridge/session/{session_id}",
            delete(disconnect_bridge_session),
        )
        // Match the authenticated account proxy limit; long transcripts exceed
        // Axum's default 2 MiB JSON body limit. Keep a finite transport bound.
        .layer(DefaultBodyLimit::max(BRIDGE_BODY_LIMIT))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_bridge_token,
        ))
        .with_state(state);
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!(%error, "OpenCut Classic bridge stopped");
        }
    });
    Ok(ClassicBridgeServer {
        address,
        config_path,
        instance_config_path,
        token,
        task,
    })
}

fn bridge_instance_config_path(config_path: &Path) -> PathBuf {
    let directory = config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("mcp-classic-bridges");
    directory.join(format!("{}.json", std::process::id()))
}

pub fn default_classic_bridge_config_path() -> PathBuf {
    if let Some(directory) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(directory)
            .join("OpenCut")
            .join("mcp-classic-bridge.json");
    }
    if let Some(directory) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(directory)
            .join("opencut")
            .join("mcp-classic-bridge.json");
    }
    if let Some(directory) = std::env::var_os("HOME") {
        return PathBuf::from(directory)
            .join(".opencut")
            .join("mcp-classic-bridge.json");
    }
    std::env::temp_dir()
        .join("opencut")
        .join("mcp-classic-bridge.json")
}

async fn require_bridge_token(
    State(state): State<BridgeHttpState>,
    request: Request,
    next: Next,
) -> Response {
    let authorized = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| bool::from(token.as_bytes().ct_eq(state.expected_token.as_bytes())));
    if !authorized {
        return (StatusCode::UNAUTHORIZED, "missing or invalid bearer token").into_response();
    }
    next.run(request).await
}

async fn bridge_status(State(state): State<BridgeHttpState>) -> Json<BridgeStatus> {
    let session = state.bridge.select_session(None, None);
    let connected = session
        .as_ref()
        .is_some_and(|snapshot| !is_session_stale(snapshot));
    Json(BridgeStatus {
        healthy: true,
        supports_canonical_invocation: true,
        connected,
        session_id: session.as_ref().map(|session| session.session_id.clone()),
        project_id: session.as_ref().map(|session| session.project_id.clone()),
        project_name: session.as_ref().map(|session| session.project_name.clone()),
        revision: session.as_ref().map(|session| session.revision),
    })
}

async fn update_bridge_state(
    State(state): State<BridgeHttpState>,
    Json(snapshot): Json<ClassicSessionSnapshot>,
) -> Response {
    match state.bridge.update_session(snapshot) {
        Ok(capability_count) => Json(json!({
            "connected": true,
            "capabilityCount": capability_count
        }))
        .into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response(),
    }
}

async fn update_bridge_heartbeat(
    State(state): State<BridgeHttpState>,
    AxumPath(session_id): AxumPath<String>,
    Json(heartbeat): Json<ClassicHeartbeat>,
) -> Response {
    match state.bridge.update_heartbeat(&session_id, heartbeat) {
        Ok(()) => Json(json!({"connected":true})).into_response(),
        Err(error) => (
            StatusCode::CONFLICT,
            Json(json!({"error":error,"needsFullState":true})),
        )
            .into_response(),
    }
}

async fn poll_bridge_commands(
    State(state): State<BridgeHttpState>,
    AxumPath(session_id): AxumPath<String>,
) -> Json<CommandBatch> {
    Json(CommandBatch {
        commands: state.bridge.take_commands(&session_id),
        cancelled_command_ids: state.bridge.inner.command_state.lock().ok().and_then(|mut s| s.cancellations.remove(&session_id)).unwrap_or_default(),
    })
}

async fn complete_bridge_command(
    State(state): State<BridgeHttpState>,
    AxumPath(session_id): AxumPath<String>,
    Json(completion): Json<ClassicCommandCompletion>,
) -> Response {
    if state.bridge.complete_command(&session_id, completion) {
        Json(json!({"accepted": true})).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "command or session was not found"})),
        )
            .into_response()
    }
}

async fn disconnect_bridge_session(
    State(state): State<BridgeHttpState>,
    AxumPath(session_id): AxumPath<String>,
) -> Json<Value> {
    state.bridge.disconnect(&session_id);
    Json(json!({"connected": false}))
}

fn tool_access(tool: &ClassicToolDescriptor) -> AccessLevel {
    if tool.read_only || tool.risk.as_deref() == Some("read") {
        return AccessLevel::Read;
    }
    match tool.risk.as_deref() {
        Some("destructive" | "external") => AccessLevel::Destructive,
        _ => AccessLevel::Write,
    }
}

fn classic_capability_id(tool_name: &str) -> Option<String> {
    let normalized = tool_name
        .split('.')
        .map(|part| {
            part.chars()
                .map(|character| {
                    let character = character.to_ascii_lowercase();
                    if character.is_ascii_lowercase()
                        || character.is_ascii_digit()
                        || matches!(character, '_' | '-')
                    {
                        character
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(".");
    if normalized.is_empty() || normalized.split('.').any(str::is_empty) {
        None
    } else {
        Some(format!("classic.{normalized}"))
    }
}

fn command_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "output": {},
            "applied": {"type": "boolean"},
            "revision": {"type": ["integer", "null"]}
        },
        "required": ["output", "applied", "revision"],
        "additionalProperties": false
    })
}

/// Copy only bounded, checksummed artifacts; browser-local IDs are never handed
/// to an MCP client as though they belonged to this runtime's ArtifactStore.
fn import_browser_artifacts(output: &mut Value, incoming: Vec<BridgeArtifact>, store: &ArtifactStore) -> Result<Vec<ArtifactRef>, CapabilityError> {
    if incoming.len() > 16 || incoming.iter().fold(0_u64, |sum, a| sum.saturating_add(a.metadata.byte_size)) > 16 * 1024 * 1024 {
        return Err(CapabilityError::InvalidInput("Browser artifacts exceed the transfer bound".into()));
    }
    let mut refs = Vec::new();
    for item in incoming {
        if item.data_base64.len() > 24 * 1024 * 1024 { return Err(CapabilityError::InvalidInput("Browser artifact encoding exceeds its bound".into())); }
        let bytes = BASE64.decode(&item.data_base64).map_err(|_| CapabilityError::InvalidInput("Invalid browser artifact encoding".into()))?;
        if bytes.len() as u64 != item.metadata.byte_size { return Err(CapabilityError::InvalidInput("Browser artifact size mismatch".into())); }
        let artifact = store.put(bytes, &item.metadata.mime_type, item.metadata.width, item.metadata.height, item.metadata.duration_ms).map_err(|e| CapabilityError::Failed(e.to_string()))?;
        if artifact.sha256 != item.metadata.sha256 {
            let _ = store.remove(&artifact.id);
            return Err(CapabilityError::InvalidInput("Browser artifact checksum mismatch".into()));
        }
        fn remap(value: &mut Value, old: &ArtifactRef, new: &ArtifactRef) {
            match value {
                Value::String(s) if s == &old.uri => *s = new.uri.clone(),
                Value::String(s) if s == &old.id => *s = new.id.clone(),
                Value::Array(items) => items.iter_mut().for_each(|v| remap(v, old, new)),
                Value::Object(object) if object.get("uri").and_then(Value::as_str) == Some(&old.uri) => *value = serde_json::to_value(new).expect("artifact metadata"),
                Value::Object(object) => object.values_mut().for_each(|v| remap(v, old, new)),
                _ => {}
            }
        }
        remap(output, &item.metadata, &artifact);
        refs.push(artifact);
    }
    Ok(refs)
}

fn collect_data_url_artifacts(
    value: &mut Value,
    artifacts: &ArtifactStore,
    refs: &mut Vec<ArtifactRef>,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_data_url_artifacts(item, artifacts, refs);
            }
        }
        Value::Object(object) => {
            if let Some(data_url) = object
                .get("dataUrl")
                .and_then(Value::as_str)
                .map(str::to_owned)
                && let Some((mime_type, encoded)) = parse_data_url(&data_url)
                && let Ok(bytes) = BASE64.decode(encoded)
                && let Ok(artifact) = artifacts.put(bytes, mime_type, None, None, None)
            {
                object.remove("dataUrl");
                object.insert("artifactUri".into(), Value::String(artifact.uri.clone()));
                refs.push(artifact);
            }
            for child in object.values_mut() {
                collect_data_url_artifacts(child, artifacts, refs);
            }
        }
        _ => {}
    }
}

fn parse_data_url(value: &str) -> Option<(&str, &str)> {
    let body = value.strip_prefix("data:")?;
    let (metadata, encoded) = body.split_once(',')?;
    let mime_type = metadata.strip_suffix(";base64")?;
    mime_type
        .starts_with("image/")
        .then_some((mime_type, encoded))
}

fn is_session_stale(snapshot: &ClassicSessionSnapshot) -> bool {
    now_ms().saturating_sub(snapshot.updated_at_ms) > SESSION_STALE_AFTER_MS
}

fn is_session_too_stale_for_command(snapshot: &ClassicSessionSnapshot) -> bool {
    now_ms().saturating_sub(snapshot.updated_at_ms) > SESSION_COMMAND_STALE_AFTER_MS
}

fn snapshot_is_visible(snapshot: &ClassicSessionSnapshot) -> bool {
    snapshot.ui.get("visibilityState").and_then(Value::as_str) == Some("visible")
}

fn snapshot_is_focused(snapshot: &ClassicSessionSnapshot) -> bool {
    snapshot
        .ui
        .get("focused")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn snapshot_last_active_at_ms(snapshot: &ClassicSessionSnapshot) -> u64 {
    snapshot
        .ui
        .get("lastActiveAtMs")
        .and_then(Value::as_u64)
        .unwrap_or_default()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn write_bridge_config(path: &Path, address: SocketAddr, token: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(&json!({
        "version": 2,
        "supportsHeartbeat": true,
        "baseUrl": format!("http://{address}"),
        "token": token,
        "pid": std::process::id(),
        "createdAtMs": now_ms()
    }))
    .map_err(std::io::Error::other)?;
    std::fs::write(&temporary, bytes)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    std::fs::rename(temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connected_snapshot(tools: Vec<ClassicToolDescriptor>) -> ClassicSessionSnapshot {
        ClassicSessionSnapshot {
            session_id: "classic-session".into(),
            project_id: "classic-project".into(),
            project_name: "Classic Project".into(),
            revision: 7,
            canonical_revision: None,
            dirty: false,
            playback: json!({}),
            timeline: json!({}),
            selection: json!({}),
            ui: json!({}),
            tools,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn classic_tool_names_become_valid_capability_ids() {
        assert_eq!(
            classic_capability_id("timeline.read_full_source").as_deref(),
            Some("classic.timeline.read_full_source")
        );
        assert_eq!(
            classic_capability_id("Preview Capture Frame").as_deref(),
            Some("classic.preview_capture_frame")
        );
    }

    #[test]
    fn data_url_images_become_bounded_artifacts() {
        let store = ArtifactStore::default();
        let mut value = json!({
            "success": true,
            "mimeType": "image/png",
            "dataUrl": "data:image/png;base64,iVBORw0KGgo="
        });
        let mut refs = Vec::new();
        collect_data_url_artifacts(&mut value, &store, &mut refs);
        assert_eq!(refs.len(), 1);
        assert!(value.get("dataUrl").is_none());
        assert!(
            value
                .get("artifactUri")
                .and_then(Value::as_str)
                .is_some_and(|uri| uri.starts_with("opencut://artifacts/"))
        );
    }

    #[test]
    fn tracks_multiple_browser_tabs_and_keeps_the_visible_tab_active() {
        let runtime = OpenCutRuntime::full_access().unwrap();
        let bridge = ClassicBridge::register(&runtime).unwrap();
        let mut first = connected_snapshot(Vec::new());
        first.session_id = "first-tab".into();
        first.project_id = "first-project".into();
        first.project_name = "First Project".into();
        first.ui = json!({"visibilityState": "visible", "focused": true, "lastActiveAtMs": 100});
        first.playback = json!({"positionSeconds": 3.0});
        bridge.update_session(first).unwrap();

        let mut second = connected_snapshot(Vec::new());
        second.session_id = "second-tab".into();
        second.project_id = "second-project".into();
        second.project_name = "Second Project".into();
        second.ui = json!({"visibilityState": "hidden", "focused": false, "lastActiveAtMs": 50});
        second.playback = json!({"positionSeconds": 9.0});
        bridge.update_session(second.clone()).unwrap();

        let snapshot = bridge.session_value();
        assert_eq!(snapshot["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["session"]["sessionId"], "first-tab");
        assert_eq!(
            bridge
                .select_session(Some("second-project"), None)
                .unwrap()
                .session_id,
            "second-tab"
        );

        second.ui = json!({"visibilityState": "hidden", "focused": false, "lastActiveAtMs": 200});
        bridge.update_session(second.clone()).unwrap();
        assert_eq!(bridge.session_value()["session"]["sessionId"], "second-tab");

        second.ui = json!({"visibilityState": "visible", "focused": true});
        bridge.update_session(second).unwrap();
        assert_eq!(bridge.session_value()["session"]["sessionId"], "second-tab");

        bridge.disconnect("second-tab");
        assert_eq!(bridge.session_value()["session"]["sessionId"], "first-tab");
    }

    #[tokio::test]
    async fn invokes_connected_classic_project_without_a_headless_project_session() {
        let runtime = OpenCutRuntime::full_access().unwrap();
        let bridge = ClassicBridge::register(&runtime).unwrap();
        bridge
            .update_session(connected_snapshot(vec![ClassicToolDescriptor {
                name: "skills.list".into(),
                description: "List browser skills".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
                category: Some("knowledge".into()),
                keywords: vec!["skills".into()],
                read_only: true,
                idempotent: true,
                open_world: false,
                risk: Some("read".into()),
                canonical: None,
            }]))
            .unwrap();
        assert!(runtime.snapshot().unwrap().project.is_none());

        let registry = runtime.registry().clone();
        let invoke = tokio::spawn(async move {
            let mut context = InvocationContext::default();
            context.metadata.insert(
                "opencut/projectId".into(),
                Value::String("classic-project".into()),
            );
            registry
                .invoke("classic.skills.list", context, json!({}))
                .await
        });

        let command = loop {
            if let Some(command) = bridge.take_commands("classic-session").pop() {
                break command;
            }
            tokio::task::yield_now().await;
        };
        assert_eq!(command.project_id, "classic-project");
        assert_eq!(command.tool_name, "skills.list");
        let mut other_account = connected_snapshot(Vec::new());
        other_account.session_id = "other-account-session".into();
        bridge.update_session(other_account).unwrap();
        assert!(!bridge.complete_command(
            "other-account-session",
            ClassicCommandCompletion {
                command_id: command.id.clone(),
                ok: true,
                output: json!({"forged": true}),
                error: None,
                applied: true,
                revision: Some(999),
                artifacts: Vec::new(),
            },
        ));
        assert!(bridge.complete_command(
            "classic-session",
            ClassicCommandCompletion {
                command_id: command.id,
                ok: true,
                output: json!({"skills": [{"name": "premium"}]}),
                error: None,
                applied: false,
                revision: Some(7),
                artifacts: Vec::new(),
            },
        ));

        let receipt = invoke.await.unwrap().unwrap();
        assert_eq!(
            receipt.result.data["output"]["skills"][0]["name"],
            "premium"
        );
    }
}

#[cfg(test)]
mod body_limit_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn request(
        server: &ClassicBridgeServer,
        token: &str,
        body: String,
        method: &str,
        path: &str,
    ) -> String {
        let mut socket = tokio::net::TcpStream::connect(server.address())
            .await
            .unwrap();
        let headers = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        socket.write_all(headers.as_bytes()).await.unwrap();
        // A rejected oversized request may close before the remaining bytes are sent.
        let _ = socket.write_all(body.as_bytes()).await;
        let mut response = vec![];
        socket.read_to_end(&mut response).await.unwrap();
        String::from_utf8(response).unwrap()
    }
    async fn put(server: &ClassicBridgeServer, token: &str, body: String) -> String {
        request(server, token, body, "PUT", "/bridge/state").await
    }
    #[tokio::test]
    async fn large_transcript_snapshots_remain_authenticated_and_bounded() {
        let runtime = OpenCutRuntime::default();
        let dir = std::env::temp_dir().join(format!(
            "opencut-bridge-body-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let server = spawn_classic_bridge(
            &runtime,
            "127.0.0.1:0".parse().unwrap(),
            dir.join("config.json"),
        )
        .await
        .unwrap();
        let snapshot = json!({"sessionId":"large","projectId":"large-project","projectName":"Large transcript", "revision":1,"dirty":false,"playback":{},"timeline":{"text":"x".repeat(2*1024*1024+100)},"selection":{},"ui":{},"tools":[]});
        let response = put(&server, &server.token, snapshot.to_string()).await;
        assert!(
            response.starts_with("HTTP/1.1 200"),
            "{}",
            response.lines().next().unwrap()
        );
        assert!(
            put(&server, "wrong-token", "{}".into())
                .await
                .starts_with("HTTP/1.1 401")
        );
        let oversized =
            json!({"invalidDiagnosticPadding":"x".repeat(BRIDGE_BODY_LIMIT)}).to_string();
        assert!(
            put(&server, &server.token, oversized)
                .await
                .starts_with("HTTP/1.1 413")
        );
        let heartbeat=json!({"projectId":"large-project","projectName":"Large transcript","expectedRevision":1,"revision":2,"dirty":true,"playback":{"position":17},"selection":[],"ui":{}}).to_string();
        assert!(
            request(
                &server,
                &server.token,
                heartbeat.clone(),
                "POST",
                "/bridge/heartbeat/large"
            )
            .await
            .starts_with("HTTP/1.1 200")
        );
        assert!(
            request(
                &server,
                &server.token,
                heartbeat.clone(),
                "POST",
                "/bridge/heartbeat/large"
            )
            .await
            .starts_with("HTTP/1.1 409")
        );
        assert!(
            request(
                &server,
                "wrong-token",
                heartbeat,
                "POST",
                "/bridge/heartbeat/large"
            )
            .await
            .starts_with("HTTP/1.1 401")
        );
        assert!(
            request(
                &server,
                &server.token,
                json!({"invalid":"x".repeat(512*1024)}).to_string(),
                "POST",
                "/bridge/heartbeat/large"
            )
            .await
            .starts_with("HTTP/1.1 413")
        );
        drop(server);
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod heartbeat_tests {
    use super::*;
    #[test]
    fn metadata_heartbeat_keeps_document_and_tool_storage_and_requires_exact_session_revision() {
        let runtime = OpenCutRuntime::default();
        let bridge = ClassicBridge::register(&runtime).unwrap();
        let snapshot:ClassicSessionSnapshot=serde_json::from_value(json!({"sessionId":"account_tab","projectId":"p","projectName":"P","revision":1,"dirty":false,"playback":{},"timeline":{"text":"x".repeat(3*1024*1024)},"selection":{},"ui":{},"tools":[]})).unwrap();
        bridge.update_session(snapshot).unwrap();
        let pointer = bridge.inner.sessions.read().unwrap()["account_tab"].timeline["text"]
            .as_str()
            .unwrap()
            .as_ptr() as usize;
        let heartbeat = |project: &str, expected: u64, revision: u64| {
            serde_json::from_value::<ClassicHeartbeat>(json!({"projectId":project,"projectName":"P","expectedRevision":expected,"revision":revision,"dirty":true,"playback":{"position":17},"selection":["clip"],"ui":{"focused":true,"visibilityState":"visible"}})).unwrap()
        };
        assert!(
            bridge
                .update_heartbeat("other_tab", heartbeat("p", 1, 2))
                .is_err()
        );
        assert!(
            bridge
                .update_heartbeat("account_tab", heartbeat("other", 1, 2))
                .is_err()
        );
        assert!(
            bridge
                .update_heartbeat("account_tab", heartbeat("p", 0, 2))
                .is_err()
        );
        bridge
            .update_heartbeat("account_tab", heartbeat("p", 1, 2))
            .unwrap();
        {
            let sessions = bridge.inner.sessions.read().unwrap();
            let updated = &sessions["account_tab"];
            assert_eq!(
                updated.timeline["text"].as_str().unwrap().as_ptr() as usize,
                pointer
            );
            assert_eq!(
                updated.timeline["text"].as_str().unwrap().len(),
                3 * 1024 * 1024
            );
            assert_eq!(updated.revision, 2);
            assert_eq!(updated.playback["position"], 17);
        }
        assert!(
            bridge
                .update_heartbeat("account_tab", heartbeat("p", 1, 3))
                .is_err()
        );
        bridge
            .update_heartbeat("account_tab", heartbeat("p", 2, 2))
            .unwrap();
    }
}

#[cfg(test)]
mod canonical_transport_tests {
    use super::*;
    use crate::OpenCutMcp;
    use opencut_editor_api::{HostBridge, HostEffectResult, register_earshot_preview};
    use rmcp::{ServiceExt, model::{CallToolRequestParams, ReadResourceRequestParams}};

    fn tool(descriptor: CapabilityDescriptor) -> ClassicToolDescriptor {
        ClassicToolDescriptor {
            name: format!("canonical.{}", descriptor.id), description: descriptor.description.clone(),
            parameters: descriptor.input_schema.clone(), category: Some(descriptor.category.clone()),
            keywords: descriptor.tags.clone(), read_only: descriptor.access == AccessLevel::Read,
            idempotent: descriptor.idempotent, open_world: descriptor.open_world, risk: None,
            canonical: Some(descriptor),
        }
    }
    async fn setup() -> (OpenCutRuntime, OpenCutRuntime, HostBridge, ClassicBridge) {
        let native = OpenCutRuntime::full_access().unwrap();
        let browser = OpenCutRuntime::full_access().unwrap();
        let host = HostBridge::default();
        register_earshot_preview(&browser, &host).unwrap();
        browser.registry().invoke("project.classic.session.attach", InvocationContext::default(), json!({
            "projectId":"classic-project", "expectedRevision":0,
            "classic":serde_json::from_str::<Value>(include_str!("../../editor-api/tests/fixtures/classic-project.json")).unwrap()
        })).await.unwrap();
        let bridge = ClassicBridge::register(&native).unwrap();
        let tools = ["audio.earshot.preview", "project.classic.settings.update", "app.state.read"].into_iter()
            .map(|id| tool(browser.registry().descriptor(id).unwrap().unwrap())).collect();
        bridge.update_session(ClassicSessionSnapshot {
            session_id:"live-tab".into(), project_id:"classic-project".into(), project_name:"Live".into(),
            revision:999, canonical_revision:Some(browser.snapshot().unwrap().revision), dirty:false,
            playback:json!({}),timeline:json!({}),selection:json!({}),ui:json!({}),tools,updated_at_ms:0,
        }).unwrap();
        (native, browser, host, bridge)
    }
    async fn next(bridge: &ClassicBridge) -> ClassicCommand {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(command) = bridge.take_commands("live-tab").pop() { return command; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap()
    }
    async fn execute(browser: &OpenCutRuntime, host: &HostBridge, bridge: &ClassicBridge, command: ClassicCommand) {
        let before = browser.snapshot().unwrap().revision;
        let context = InvocationContext {
            source: "mcp.browser-fixture".into(), dry_run:command.context["dryRun"].as_bool().unwrap(),
            request_id:command.context["requestId"].as_str().map(str::to_owned),
            metadata: command.context["metadata"].as_object().unwrap().clone(), ..Default::default()
        };
        let id = command.tool_name.strip_prefix("canonical.").unwrap();
        let registry = browser.registry().clone();
        let pending = registry.invoke(id, context, command.arguments);
        tokio::pin!(pending);
        let receipt = loop {
            tokio::select! {
                result = &mut pending => break result.unwrap(),
                _ = tokio::task::yield_now() => {
                    if let Some(effect) = host.pending().unwrap().pop() {
                        assert_eq!(effect.adapter, "earshotPreview");
                        let frames = effect.request["frames"].as_u64().unwrap();
                        let bytes: Vec<u8> = (0..frames).flat_map(|_| 16384_i16.to_le_bytes()).collect();
                        host.settle(effect.id, HostEffectResult::Success {data:json!({"channels":1,"pcm16Base64":BASE64.encode(bytes)})}).unwrap();
                    }
                }
            }
        };
        let artifacts = receipt.result.artifacts.iter().map(|metadata| BridgeArtifact {
            metadata:metadata.clone(), data_base64:BASE64.encode(&browser.artifacts().get(&metadata.uri).unwrap().bytes)
        }).collect();
        assert!(bridge.complete_command("live-tab", ClassicCommandCompletion {
            command_id:command.id,ok:true,output:receipt.result.data,error:None,
            applied:browser.snapshot().unwrap().revision != before,revision:Some(browser.snapshot().unwrap().revision),artifacts,
        }));
    }

    #[tokio::test]
    async fn actual_mcp_wire_discovers_and_previews_in_browser_with_readable_audio_artifact() {
        let (native, browser, host, bridge) = setup().await;
        let (server_transport, client_transport) = tokio::io::duplex(4 * 1024 * 1024);
        let server = OpenCutMcp::from_runtime(&native);
        let task = tokio::spawn(async move { server.serve(server_transport).await.unwrap().waiting().await.unwrap(); });
        let client = ().serve(client_transport).await.unwrap();
        let inventory = client.list_all_tools().await.unwrap();
        let preview = inventory.iter().find(|t| t.name == "opencut.classic.canonical.audio.earshot.preview").unwrap();
        assert_eq!(preview.annotations.as_ref().unwrap().read_only_hint, Some(false));
        assert_eq!(preview.annotations.as_ref().unwrap().open_world_hint, Some(true));
        let input = json!({"browserSessionId":"live-tab", "projectId":"classic-project", "expectedRevision":browser.snapshot().unwrap().revision,
            "procedural":{"version":1,"engine":"earshot","bankRevision":"591fa3e028032e6dce56620a20e932e35667e8d8","presetId":"whoosh_fast/whip","seed":42,"duration":0.1},"durationSeconds":0.02});
        let dispatch = client.call_tool(CallToolRequestParams::new(preview.name.clone()).with_arguments(input.as_object().unwrap().clone()));
        let work = async { execute(&browser, &host, &bridge, next(&bridge).await).await; };
        let (reply, ()) = tokio::join!(dispatch, work);
        let reply = reply.unwrap();
        assert_ne!(reply.is_error, Some(true), "{reply:?}");
        let encoded = serde_json::to_value(&reply).unwrap();
        assert!(encoded["content"].as_array().unwrap().iter().any(|v| v["type"] == "audio" && v["mimeType"] == "audio/wav"));
        let result = &encoded["structuredContent"]["result"]["data"]["output"];
        assert_eq!(result["peak"], 0.5);
        let uri = result["artifact"]["uri"].as_str().unwrap();
        assert_eq!(&native.artifacts().get(uri).unwrap().bytes[..4], b"RIFF");
        let resource = client.read_resource(ReadResourceRequestParams::new(uri)).await.unwrap();
        assert_eq!(serde_json::to_value(resource).unwrap()["contents"][0]["mimeType"], "audio/wav");
        assert!(native.snapshot().unwrap().project.is_none());
        assert_eq!(browser.snapshot().unwrap().revision, 1);
        client.cancel().await.unwrap(); task.await.unwrap();
    }

    #[tokio::test]
    async fn live_registry_writes_keep_canonical_revisions_scope_dry_run_and_idempotency() {
        let (native, browser, host, bridge) = setup().await;
        let server = OpenCutMcp::from_runtime(&native);
        let id = "classic.canonical.project.classic.settings.update";
        let input = json!({"projectId":"classic-project","browserSessionId":"live-tab","expectedRevision":1,"idempotencyKey":"one-live-edit","settings":{"canvasSize":{"width":720,"height":1280}}});
        let mut dry = InvocationContext::default(); dry.dry_run = true;
        let call = server.call_generated_capability(id, input.as_object().unwrap().clone(), dry);
        let (result, ()) = tokio::join!(call, async { let c=next(&bridge).await; assert_eq!(c.context["dryRun"],true); execute(&browser,&host,&bridge,c).await; });
        assert_ne!(result.is_error, Some(true)); assert_eq!(browser.snapshot().unwrap().revision,1);
        let call = server.call_generated_capability(id, input.as_object().unwrap().clone(), InvocationContext::default());
        let (result, ()) = tokio::join!(call, async { execute(&browser,&host,&bridge,next(&bridge).await).await; });
        assert_ne!(result.is_error, Some(true)); assert_eq!(browser.snapshot().unwrap().revision,2);
        assert_eq!(browser.snapshot().unwrap().project.unwrap().settings.width,720);
        let replay = server.call_generated_capability(id,input.as_object().unwrap().clone(),InvocationContext::default()).await;
        assert_eq!(replay.structured_content,result.structured_content); assert!(bridge.take_commands("live-tab").is_empty());
        let mut wrong=input.clone(); wrong["browserSessionId"]=json!("wrong-tab"); wrong["idempotencyKey"]=json!("other-call");
        assert_eq!(server.call_generated_capability(id,wrong.as_object().unwrap().clone(),InvocationContext::default()).await.is_error,Some(true));
        let mut stale=input; stale["expectedRevision"]=json!(999); stale.as_object_mut().unwrap().remove("idempotencyKey");
        assert_eq!(server.call_generated_capability(id,stale.as_object().unwrap().clone(),InvocationContext::default()).await.is_error,Some(true));
        assert!(native.snapshot().unwrap().project.is_none());
    }

    #[tokio::test]
    async fn lost_browser_reply_retries_the_original_revision_without_repeating_the_write() {
        let (native,browser,host,bridge)=setup().await;
        let mut context=InvocationContext::default();
        context.metadata.insert("opencut/idempotencyKey".into(),json!("lost-reply"));
        let input=json!({"projectId":"classic-project","expectedRevision":1,"settings":{"canvasSize":{"width":720,"height":1280}}});
        let cancel=context.cancellation.clone();
        let pending=native.registry().invoke("classic.canonical.project.classic.settings.update",context.clone(),input.clone());
        tokio::pin!(pending);
        let command=tokio::select! { _=&mut pending=>panic!("must await browser"), c=next(&bridge)=>c };
        // The browser commits and caches its canonical receipt; the reply is lost.
        browser.registry().invoke("project.classic.settings.update",context.clone(),command.arguments).await.unwrap();
        assert_eq!(browser.snapshot().unwrap().revision,2);
        cancel.cancel(); assert!(pending.await.is_err());
        bridge.inner.sessions.write().unwrap().get_mut("live-tab").unwrap().canonical_revision=Some(2);
        context.cancellation=Default::default();
        let retry=native.registry().invoke("classic.canonical.project.classic.settings.update",context,input);
        let (receipt,())=tokio::join!(retry,async {execute(&browser,&host,&bridge,next(&bridge).await).await;});
        assert!(receipt.is_ok()); assert_eq!(browser.snapshot().unwrap().revision,2);
    }

    #[tokio::test]
    async fn late_bound_invocation_cannot_bypass_canonical_host_availability() {
        let (native,_browser,_host,bridge)=setup().await;
        let mut snapshot=bridge.select_session(None,Some("live-tab")).unwrap();
        let descriptor=snapshot.tools.iter_mut().find(|tool|tool.name=="canonical.audio.earshot.preview").unwrap().canonical.as_mut().unwrap();
        descriptor.available=false;
        descriptor.unavailable_reason=Some("Host unavailable".into());
        bridge.update_session(snapshot).unwrap();
        let result=native.registry().invoke("classic.tool.invoke",InvocationContext::default(),json!({"toolName":"canonical.audio.earshot.preview","browserSessionId":"live-tab","arguments":{}})).await;
        assert!(result.is_err()); assert!(bridge.take_commands("live-tab").is_empty());
        let status=bridge_status(State(BridgeHttpState {bridge,expected_token:Arc::from("test-token")})).await.0;
        assert_eq!(serde_json::to_value(status).unwrap()["supportsCanonicalInvocation"],true);
    }

    #[tokio::test]
    async fn internal_agent_capabilities_are_unavailable_to_external_discovery_and_execution() {
        let (native, browser, _host, bridge) = setup().await;
        let ids = [
            "computer.observe",
            "computer.execute",
            "computer.future.operation",
            "agent.policy.set",
            "agent.policy.future",
        ];
        let mut snapshot = bridge.select_session(None, Some("live-tab")).unwrap();
        for id in ids {
            let descriptor = CapabilityDescriptor::read(
                id, id, "Internal editor capability", "agent",
                json!({"type":"object"}), json!({"type":"object"}),
            );
            assert!(descriptor.available);
            let name = format!("canonical.{id}");
            snapshot.tools.retain(|candidate| candidate.name != name);
            snapshot.tools.push(tool(descriptor));
        }
        // Simulate an older browser advertising internal capabilities as usable.
        bridge.update_session(snapshot).unwrap();
        let discovered = native.registry().snapshot().unwrap().capabilities;
        let session = bridge.select_session(None, Some("live-tab")).unwrap();
        let browser_before = serde_json::to_value(browser.snapshot().unwrap()).unwrap();
        for id in ids {
            let tool_name = format!("canonical.{id}");
            let native_id = format!("classic.{tool_name}");
            let descriptor = discovered.iter().find(|item| item.id == native_id).unwrap();
            assert!(!descriptor.available);
            assert!(descriptor.unavailable_reason.as_deref().unwrap().contains("internal editor"));
            let advertised = session.tools.iter().find(|item| item.name == tool_name).unwrap();
            assert!(!advertised.canonical.as_ref().unwrap().available);
            let direct = native.registry().invoke(
                &native_id, InvocationContext::default(), json!({"browserSessionId":"live-tab"}),
            ).await;
            assert!(direct.unwrap_err().to_string().contains("internal editor"));

            // Late-bound invocation must reject by name, even without canonical
            // metadata; unavailable discovery alone is not an execution guard.
            bridge.inner.sessions.write().unwrap().get_mut("live-tab").unwrap()
                .tools.iter_mut().find(|item| item.name == tool_name).unwrap().canonical = None;
            let late_bound = tokio::time::timeout(Duration::from_secs(1), native.registry().invoke(
                "classic.tool.invoke", InvocationContext::default(),
                json!({"toolName":tool_name,"browserSessionId":"live-tab","arguments":{}}),
            )).await.expect("blocked tools must never await a browser command");
            assert!(late_bound.unwrap_err().to_string().contains("internal editor"));
            assert!(bridge.take_commands("live-tab").is_empty());
        }
        assert_eq!(serde_json::to_value(browser.snapshot().unwrap()).unwrap(), browser_before);
        assert!(native.registry().snapshot().unwrap().capabilities.iter().any(|descriptor|
            descriptor.id == "classic.canonical.audio.earshot.preview" && descriptor.available
        ));
    }

    #[tokio::test]
    async fn cancelled_live_commands_are_signalled_to_the_owning_browser() {
        let (native, _browser, _host, bridge)=setup().await;
        let context=InvocationContext::default(); let cancel=context.cancellation.clone();
        let pending=native.registry().invoke("classic.canonical.app.state.read",context,json!({"browserSessionId":"live-tab"}));
        tokio::pin!(pending);
        let command=tokio::select! { _=&mut pending=>panic!("must wait for browser"), c=next(&bridge)=>c };
        cancel.cancel(); assert!(pending.await.is_err());
        let signals=bridge.inner.command_state.lock().unwrap().cancellations.remove("live-tab").unwrap();
        assert_eq!(signals,vec![command.id]);
    }
}
