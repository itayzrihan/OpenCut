//! Model Context Protocol adapter for OpenCut's Editor API.
//!
//! Tool definitions are generated from the live capability registry. Adding a
//! capability to OpenCut therefore adds a typed MCP tool without editing this
//! crate.

mod classic_bridge;

pub use classic_bridge::{
    ClassicBridgeServer, default_classic_bridge_config_path, spawn_classic_bridge,
};

use std::{
    borrow::Cow,
    collections::HashSet,
    net::SocketAddr,
    sync::{Arc, RwLock},
};

use axum::{
    Router,
    extract::{Request, State},
    http::{StatusCode, header::AUTHORIZATION},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use opencut_editor_api::{
    ARTIFACT_URI_PREFIX, AccessLevel, ArtifactStore, CapabilityDescriptor, CapabilityRegistry,
    InvocationContext, OpenCutRuntime, RegistryError, RegistryEvent,
};
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResult, ContentBlock, Implementation,
        ListResourceTemplatesResult, ListResourcesResult, ListToolsResult, PaginatedRequestParams,
        ReadResourceRequestParams, ReadResourceResult, Resource, ResourceContents,
        ResourceTemplate, ServerCapabilities, ServerInfo, SubscribeRequestParams, Tool,
        ToolAnnotations, UnsubscribeRequestParams,
    },
    service::{NotificationContext, RequestContext},
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde_json::{Map, Value, json};
use subtle::ConstantTimeEq;

const TOOL_PREFIX: &str = "opencut.";
const DISCOVER_TOOL: &str = "opencut.discover";
const DESCRIBE_TOOL: &str = "opencut.describe";
const INVOKE_TOOL: &str = "opencut.invoke";
const BATCH_TOOL: &str = "opencut.batch";
const MANIFEST_URI: &str = "opencut://manifest";
const STATE_URI: &str = "opencut://state";
const JOBS_URI: &str = "opencut://jobs";
const CAPABILITY_URI_PREFIX: &str = "opencut://capabilities/";

#[derive(Clone)]
pub struct OpenCutMcp {
    registry: CapabilityRegistry,
    artifacts: Option<ArtifactStore>,
    runtime: Option<OpenCutRuntime>,
    subscriptions: Arc<RwLock<HashSet<String>>>,
}

#[derive(Clone)]
struct HttpAuth {
    expected: Arc<str>,
}

/// Serve the active OpenCut runtime over authenticated loopback Streamable HTTP.
///
/// The caller must provide a strong token and a loopback address. This is the
/// bridge used when an agent needs live desktop state rather than a headless
/// stdio runtime.
pub async fn serve_authenticated_http(
    registry: CapabilityRegistry,
    address: SocketAddr,
    bearer_token: impl Into<Arc<str>>,
) -> std::io::Result<()> {
    serve_http_inner(registry, None, None, address, bearer_token).await
}

pub async fn serve_runtime_authenticated_http(
    runtime: OpenCutRuntime,
    address: SocketAddr,
    bearer_token: impl Into<Arc<str>>,
) -> std::io::Result<()> {
    serve_http_inner(
        runtime.registry().clone(),
        Some(runtime.artifacts().clone()),
        Some(runtime),
        address,
        bearer_token,
    )
    .await
}

async fn serve_http_inner(
    registry: CapabilityRegistry,
    artifacts: Option<ArtifactStore>,
    runtime: Option<OpenCutRuntime>,
    address: SocketAddr,
    bearer_token: impl Into<Arc<str>>,
) -> std::io::Result<()> {
    if !address.ip().is_loopback() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "OpenCut MCP HTTP must bind to a loopback address",
        ));
    }

    let expected = bearer_token.into();
    if expected.len() < 32 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "OpenCut MCP bearer token must contain at least 32 characters",
        ));
    }

    let service_registry = registry.clone();
    let service_artifacts = artifacts.clone();
    let service_runtime = runtime.clone();
    let service = StreamableHttpService::new(
        move || {
            Ok(OpenCutMcp::with_runtime(
                service_registry.clone(),
                service_artifacts.clone(),
                service_runtime.clone(),
            ))
        },
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default()
            .with_allowed_origins(["http://localhost", "http://127.0.0.1"]),
    );
    let app = Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(
            HttpAuth { expected },
            require_bearer_token,
        ));
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, app).await
}

async fn require_bearer_token(
    State(auth): State<HttpAuth>,
    request: Request,
    next: Next,
) -> Response {
    let authorized = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| bool::from(token.as_bytes().ct_eq(auth.expected.as_bytes())));
    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            [("www-authenticate", "Bearer")],
            "missing or invalid bearer token",
        )
            .into_response();
    }
    next.run(request).await
}

impl OpenCutMcp {
    pub fn new(registry: CapabilityRegistry) -> Self {
        Self::with_runtime(registry, None, None)
    }

    pub fn from_runtime(runtime: &OpenCutRuntime) -> Self {
        Self::with_runtime(
            runtime.registry().clone(),
            Some(runtime.artifacts().clone()),
            Some(runtime.clone()),
        )
    }

    fn with_runtime(
        registry: CapabilityRegistry,
        artifacts: Option<ArtifactStore>,
        runtime: Option<OpenCutRuntime>,
    ) -> Self {
        Self {
            registry,
            artifacts,
            runtime,
            subscriptions: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    pub fn registry(&self) -> &CapabilityRegistry {
        &self.registry
    }

    /// Returns the current generated MCP tool inventory.
    pub fn tools(&self) -> Result<Vec<Tool>, RegistryError> {
        let mut tools = fixed_tools();
        tools.extend(
            self.registry
                .effective_snapshot()?
                .capabilities
                .into_iter()
                .map(capability_tool),
        );
        Ok(tools)
    }

    fn resource_exists(&self, uri: &str) -> bool {
        uri == MANIFEST_URI
            || uri == STATE_URI
            || uri == JOBS_URI
            || uri.strip_prefix(CAPABILITY_URI_PREFIX).is_some_and(|id| {
                self.registry
                    .descriptor(id)
                    .ok()
                    .flatten()
                    .is_some_and(|descriptor| {
                        self.registry.is_allowed(&descriptor).unwrap_or(false)
                    })
            })
            || (uri.starts_with(ARTIFACT_URI_PREFIX)
                && self
                    .artifacts
                    .as_ref()
                    .is_some_and(|artifacts| artifacts.contains(uri)))
    }

    async fn call_generated_capability(
        &self,
        descriptor_id: &str,
        mut arguments: Map<String, Value>,
        mut context: InvocationContext,
    ) -> CallToolResult {
        let descriptor = match self.registry.descriptor(descriptor_id) {
            Ok(Some(descriptor)) => descriptor,
            Ok(None) => {
                return structured_message_failure(
                    "capability_not_found",
                    format!("capability `{descriptor_id}` was not found"),
                );
            }
            Err(error) => return structured_failure(error),
        };
        if let Err(error) = self
            .activate_target_if_needed(&descriptor, &arguments, &context)
            .await
        {
            return structured_failure(error);
        }
        if let Err(message) = apply_invocation_envelope(&descriptor, &mut arguments, &mut context) {
            return structured_message_failure("invalid_input", message);
        }
        match self
            .registry
            .invoke(descriptor_id, context, Value::Object(arguments))
            .await
        {
            Ok(receipt) => self.structured_receipt_success(receipt),
            Err(error) => structured_failure(error),
        }
    }

    async fn activate_target_if_needed(
        &self,
        descriptor: &CapabilityDescriptor,
        arguments: &Map<String, Value>,
        context: &InvocationContext,
    ) -> Result<(), RegistryError> {
        if descriptor.access == AccessLevel::Read
            || descriptor.id.starts_with("classic.")
            || matches!(
                descriptor.id.as_str(),
                "project.create" | "project.open" | "project.activate" | "project.close"
            )
        {
            return Ok(());
        }
        let Some(project_id) = arguments.get("projectId").and_then(Value::as_str) else {
            return Ok(());
        };
        let Some(runtime) = &self.runtime else {
            return Ok(());
        };
        let active = runtime
            .snapshot()
            .map_err(|error| {
                RegistryError::Capability(opencut_editor_api::CapabilityError::Failed(
                    error.to_string(),
                ))
            })?
            .project
            .map(|project| project.id);
        if active.as_deref() == Some(project_id) {
            return Ok(());
        }
        let mut activation_context = context.clone();
        activation_context.source = "mcp.project-routing".into();
        activation_context.dry_run = false;
        activation_context.metadata.remove("opencut/idempotencyKey");
        self.registry
            .invoke(
                "project.activate",
                activation_context,
                json!({"projectId": project_id}),
            )
            .await?;
        Ok(())
    }

    fn structured_receipt_success(
        &self,
        receipt: opencut_editor_api::InvocationReceipt,
    ) -> CallToolResult {
        let artifact_refs = receipt.result.artifacts.clone();
        let value = serde_json::to_value(receipt).unwrap_or_else(
            |error| json!({"error": "serialization_failed", "message": error.to_string()}),
        );
        let mut result = structured_success(value);
        let Some(store) = &self.artifacts else {
            return result;
        };
        for artifact_ref in artifact_refs {
            let Ok(artifact) = store.get(&artifact_ref.uri) else {
                continue;
            };
            let encoded = BASE64.encode(&artifact.bytes);
            if artifact.metadata.mime_type.starts_with("image/") {
                result
                    .content
                    .push(ContentBlock::image(encoded, artifact.metadata.mime_type));
            } else if artifact.metadata.mime_type.starts_with("audio/") {
                result
                    .content
                    .push(ContentBlock::audio(encoded, artifact.metadata.mime_type));
            } else {
                result.content.push(ContentBlock::resource_link(
                    Resource::new(&artifact.metadata.uri, &artifact.metadata.id)
                        .with_title(&artifact.metadata.id)
                        .with_mime_type(&artifact.metadata.mime_type),
                ));
            }
        }
        result
    }

    async fn call_discover(&self, arguments: Map<String, Value>) -> CallToolResult {
        let query = arguments
            .get("query")
            .and_then(Value::as_str)
            .map(str::to_ascii_lowercase);
        let category = arguments.get("category").and_then(Value::as_str);
        let max_access = arguments
            .get("maxAccess")
            .and_then(Value::as_str)
            .and_then(parse_access);

        match self.registry.effective_snapshot() {
            Ok(mut snapshot) => {
                snapshot.capabilities.retain(|descriptor| {
                    category.is_none_or(|category| descriptor.category == category)
                        && max_access.is_none_or(|access| descriptor.access <= access)
                        && query.as_ref().is_none_or(|query| {
                            descriptor.id.to_ascii_lowercase().contains(query)
                                || descriptor.title.to_ascii_lowercase().contains(query)
                                || descriptor.description.to_ascii_lowercase().contains(query)
                                || descriptor
                                    .tags
                                    .iter()
                                    .any(|tag| tag.to_ascii_lowercase().contains(query))
                        })
                });
                structured_success(serde_json::to_value(snapshot).unwrap_or_default())
            }
            Err(error) => structured_failure(error),
        }
    }

    async fn call_describe(&self, arguments: Map<String, Value>) -> CallToolResult {
        let Some(id) = arguments.get("capabilityId").and_then(Value::as_str) else {
            return structured_message_failure("invalid_input", "`capabilityId` must be a string");
        };
        match self.registry.descriptor(id) {
            Ok(Some(descriptor)) => {
                structured_success(serde_json::to_value(descriptor).unwrap_or_default())
            }
            Ok(None) => structured_message_failure(
                "capability_not_found",
                format!("capability `{id}` was not found"),
            ),
            Err(error) => structured_failure(error),
        }
    }

    async fn call_invoke(
        &self,
        arguments: Map<String, Value>,
        mut context: InvocationContext,
    ) -> CallToolResult {
        let Some(id) = arguments.get("capabilityId").and_then(Value::as_str) else {
            return structured_message_failure("invalid_input", "`capabilityId` must be a string");
        };
        let input = arguments
            .get("input")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        context.dry_run = arguments
            .get("dryRun")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.call_generated_capability(id, input, context).await
    }

    async fn call_batch(
        &self,
        arguments: Map<String, Value>,
        context: InvocationContext,
    ) -> CallToolResult {
        let Some(calls) = arguments.get("calls").and_then(Value::as_array) else {
            return structured_message_failure("invalid_input", "`calls` must be an array");
        };
        let mode = arguments
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("atomic");
        if !matches!(mode, "atomic" | "bestEffort") {
            return structured_message_failure(
                "invalid_input",
                "`mode` must be `atomic` or `bestEffort`",
            );
        }
        let stop_on_error = arguments
            .get("stopOnError")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let mut results = Vec::with_capacity(calls.len());
        if mode == "atomic" {
            let project_ids: HashSet<_> = calls
                .iter()
                .filter_map(|call| {
                    call.get("input")
                        .and_then(Value::as_object)
                        .and_then(|input| input.get("projectId"))
                        .and_then(Value::as_str)
                })
                .collect();
            if project_ids.len() > 1 {
                return structured_message_failure(
                    "invalid_input",
                    "an atomic batch cannot target more than one project",
                );
            }
            if let Some(project_id) = project_ids.into_iter().next()
                && let Some(first_mutation) = calls.iter().find_map(|call| {
                    let id = call.get("capabilityId")?.as_str()?;
                    let descriptor = self.registry.descriptor(id).ok().flatten()?;
                    (descriptor.access != AccessLevel::Read).then_some(descriptor)
                })
            {
                let arguments =
                    Map::from_iter([("projectId".into(), Value::String(project_id.to_owned()))]);
                if let Err(error) = self
                    .activate_target_if_needed(&first_mutation, &arguments, &context)
                    .await
                {
                    return structured_failure(error);
                }
            }
        }
        let checkpoint = if mode == "atomic" {
            let Some(runtime) = &self.runtime else {
                return structured_message_failure(
                    "unavailable",
                    "atomic batches require an OpenCut runtime-backed MCP server",
                );
            };
            for call in calls {
                let Some(id) = call.get("capabilityId").and_then(Value::as_str) else {
                    return structured_message_failure(
                        "invalid_input",
                        "every atomic batch call must contain capabilityId",
                    );
                };
                let descriptor = match self.registry.descriptor(id) {
                    Ok(Some(descriptor)) => descriptor,
                    Ok(None) => {
                        return structured_message_failure(
                            "capability_not_found",
                            format!("capability `{id}` was not found"),
                        );
                    }
                    Err(error) => return structured_failure(error),
                };
                if descriptor.access != AccessLevel::Read && !descriptor.transactional {
                    return structured_message_failure(
                        "not_transactional",
                        format!("capability `{id}` cannot participate in an atomic batch"),
                    );
                }
            }
            match runtime.begin_atomic() {
                Ok(checkpoint) => Some(checkpoint),
                Err(error) => {
                    return structured_message_failure("internal_error", error.to_string());
                }
            }
        } else {
            None
        };
        let mut failed = false;

        for (index, call) in calls.iter().enumerate() {
            if context.cancellation.is_cancelled() {
                results.push(json!({
                    "index": index,
                    "ok": false,
                    "error": {"code": "cancelled", "message": "the MCP request was cancelled"}
                }));
                break;
            }
            let Some(id) = call.get("capabilityId").and_then(Value::as_str) else {
                results.push(json!({
                    "index": index,
                    "ok": false,
                    "error": {"code": "invalid_input", "message": "capabilityId must be a string"}
                }));
                if stop_on_error {
                    break;
                }
                continue;
            };
            let mut input = call
                .get("input")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut call_context = context.clone();
            call_context.source = "mcp.batch".into();
            call_context.dry_run = call.get("dryRun").and_then(Value::as_bool).unwrap_or(false);
            if mode == "atomic" {
                call_context
                    .metadata
                    .insert("opencut/transaction".into(), Value::Bool(true));
            }
            let descriptor = match self.registry.descriptor(id) {
                Ok(Some(descriptor)) => descriptor,
                Ok(None) => {
                    results.push(json!({
                        "index": index,
                        "ok": false,
                        "error": {"code": "capability_not_found", "message": format!("capability `{id}` was not found")}
                    }));
                    failed = true;
                    break;
                }
                Err(error) => {
                    results.push(json!({
                        "index": index,
                        "ok": false,
                        "error": {"code": registry_error_code(&error), "message": error.to_string()}
                    }));
                    failed = true;
                    break;
                }
            };
            if mode == "bestEffort"
                && let Err(error) = self
                    .activate_target_if_needed(&descriptor, &input, &call_context)
                    .await
            {
                results.push(json!({
                    "index": index,
                    "ok": false,
                    "error": {"code": registry_error_code(&error), "message": error.to_string()}
                }));
                failed = true;
                if stop_on_error {
                    break;
                }
                continue;
            }
            if let Err(message) =
                apply_invocation_envelope(&descriptor, &mut input, &mut call_context)
            {
                results.push(json!({
                    "index": index,
                    "ok": false,
                    "error": {"code": "invalid_input", "message": message}
                }));
                failed = true;
                if mode == "atomic" || stop_on_error {
                    break;
                }
                continue;
            }
            match self
                .registry
                .invoke(id, call_context, Value::Object(input))
                .await
            {
                Ok(receipt) => {
                    results.push(json!({"index": index, "ok": true, "receipt": receipt}))
                }
                Err(error) => {
                    failed = true;
                    results.push(json!({
                        "index": index,
                        "ok": false,
                        "error": {"code": registry_error_code(&error), "message": error.to_string()}
                    }));
                    if mode == "atomic" || stop_on_error {
                        break;
                    }
                }
            }
        }

        let final_revision = if let Some(checkpoint) = checkpoint {
            let runtime = self.runtime.as_ref().expect("checked above");
            if failed {
                if let Err(error) = runtime.rollback_atomic(checkpoint) {
                    return structured_message_failure("rollback_failed", error.to_string());
                }
                None
            } else {
                match runtime.commit_atomic(checkpoint, "MCP atomic batch") {
                    Ok(revision) => Some(revision),
                    Err(error) => {
                        return structured_message_failure(
                            "transaction_commit_failed",
                            error.to_string(),
                        );
                    }
                }
            }
        } else {
            None
        };

        structured_success(json!({
            "mode": mode,
            "committed": mode != "atomic" || !failed,
            "finalRevision": final_revision,
            "completed": results.len(),
            "requested": calls.len(),
            "results": results
        }))
    }
}

impl ServerHandler for OpenCutMcp {
    fn get_info(&self) -> ServerInfo {
        let capabilities = ServerCapabilities::builder()
            .enable_tools()
            .enable_tool_list_changed()
            .enable_resources()
            .enable_resources_list_changed()
            .enable_resources_subscribe()
            .build();
        ServerInfo::new(capabilities)
            .with_server_info(
                Implementation::new("opencut", env!("CARGO_PKG_VERSION"))
                    .with_title("OpenCut")
                    .with_description(
                        "Complete, self-describing access to the OpenCut Editor API",
                    )
                    .with_website_url("https://opencut.app"),
            )
            .with_instructions(
                "Use opencut.discover to search the live Editor API. Every registered capability is also exposed as a direct `opencut.<capability-id>` tool. Prefer direct tools when available; use opencut.invoke for late-bound capabilities. Read opencut://manifest for the complete contract.",
            )
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, McpError>> + Send + '_ {
        std::future::ready(
            self.tools()
                .map(ListToolsResult::with_all_items)
                .map_err(internal_error),
        )
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        if let Some(tool) = fixed_tools().into_iter().find(|tool| tool.name == name) {
            return Some(tool);
        }
        name.strip_prefix(TOOL_PREFIX)
            .and_then(|id| self.registry.descriptor(id).ok().flatten())
            .filter(|descriptor| self.registry.is_allowed(descriptor).unwrap_or(false))
            .map(capability_tool)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let arguments = request.arguments.unwrap_or_default();
        let invocation_context = mcp_invocation_context(&context, "mcp");
        let result = match request.name.as_ref() {
            DISCOVER_TOOL => self.call_discover(arguments).await,
            DESCRIBE_TOOL => self.call_describe(arguments).await,
            INVOKE_TOOL => self.call_invoke(arguments, invocation_context).await,
            BATCH_TOOL => self.call_batch(arguments, invocation_context).await,
            name => {
                let Some(id) = name.strip_prefix(TOOL_PREFIX) else {
                    return Err(McpError::invalid_params(
                        format!("unknown OpenCut tool `{name}`"),
                        None,
                    ));
                };
                if self
                    .registry
                    .descriptor(id)
                    .map_err(internal_error)?
                    .is_none()
                {
                    return Err(McpError::invalid_params(
                        format!("unknown OpenCut capability `{id}`"),
                        None,
                    ));
                }
                self.call_generated_capability(id, arguments, invocation_context)
                    .await
            }
        };
        Ok(result)
    }

    fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListResourcesResult, McpError>> + Send + '_ {
        let result = self.registry.effective_snapshot().map(|snapshot| {
            let mut resources = vec![
                Resource::new(MANIFEST_URI, "manifest")
                    .with_title("OpenCut Editor API manifest")
                    .with_description(
                        "Live capability inventory, schemas, versions, and access metadata",
                    )
                    .with_mime_type("application/json"),
                Resource::new(STATE_URI, "state")
                    .with_title("OpenCut live state")
                    .with_description("Complete app state exposed by app.state.read")
                    .with_mime_type("application/json"),
                Resource::new(JOBS_URI, "jobs")
                    .with_title("OpenCut background jobs")
                    .with_description("Current and recent render, capture, and media-analysis jobs")
                    .with_mime_type("application/json"),
            ];
            resources.extend(snapshot.capabilities.into_iter().map(|descriptor| {
                Resource::new(
                    format!("{CAPABILITY_URI_PREFIX}{}", descriptor.id),
                    descriptor.id.clone(),
                )
                .with_title(descriptor.title)
                .with_description(descriptor.description)
                .with_mime_type("application/json")
            }));
            if let Some(artifacts) = &self.artifacts
                && let Ok(list) = artifacts.list()
            {
                resources.extend(list.into_iter().map(|artifact| {
                    Resource::new(artifact.uri, artifact.id.clone())
                        .with_title(artifact.id)
                        .with_description(format!(
                            "OpenCut generated artifact ({} bytes, expires at {})",
                            artifact.byte_size, artifact.expires_at_ms
                        ))
                        .with_mime_type(artifact.mime_type)
                }));
            }
            ListResourcesResult::with_all_items(resources)
        });
        std::future::ready(result.map_err(internal_error))
    }

    fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListResourceTemplatesResult, McpError>> + Send + '_ {
        std::future::ready(Ok(ListResourceTemplatesResult::with_all_items(vec![
            ResourceTemplate::new("opencut://capabilities/{capabilityId}", "capability")
                .with_title("OpenCut capability descriptor")
                .with_description("Machine-readable contract for one live Editor API capability")
                .with_mime_type("application/json"),
            ResourceTemplate::new("opencut://artifacts/{artifactId}", "artifact")
                .with_title("OpenCut generated artifact")
                .with_description("Binary image, audio, or render output generated by OpenCut"),
        ])))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        if request.uri.starts_with(ARTIFACT_URI_PREFIX) {
            let store = self
                .artifacts
                .as_ref()
                .ok_or_else(|| McpError::invalid_params("artifact store is unavailable", None))?;
            let artifact = store
                .get(&request.uri)
                .map_err(|error| McpError::invalid_params(error.to_string(), None))?;
            return Ok(ReadResourceResult::new(vec![
                ResourceContents::blob(BASE64.encode(&artifact.bytes), request.uri)
                    .with_mime_type(artifact.metadata.mime_type),
            ]));
        }
        let value = if request.uri == MANIFEST_URI {
            serde_json::to_value(self.registry.effective_snapshot().map_err(internal_error)?)
                .map_err(|error| internal_error(error.to_string()))?
        } else if request.uri == STATE_URI {
            let receipt = self
                .registry
                .invoke(
                    "app.state.read",
                    InvocationContext {
                        source: "mcp.resource".into(),
                        ..Default::default()
                    },
                    json!({}),
                )
                .await
                .map_err(internal_error)?;
            receipt.result.data
        } else if request.uri == JOBS_URI {
            let receipt = self
                .registry
                .invoke(
                    "job.list",
                    InvocationContext {
                        source: "mcp.resource".into(),
                        ..Default::default()
                    },
                    json!({}),
                )
                .await
                .map_err(internal_error)?;
            receipt.result.data
        } else if let Some(id) = request.uri.strip_prefix(CAPABILITY_URI_PREFIX) {
            let descriptor = self
                .registry
                .descriptor(id)
                .map_err(internal_error)?
                .ok_or_else(|| {
                    McpError::invalid_params(format!("unknown resource `{}`", request.uri), None)
                })?;
            if !self
                .registry
                .is_allowed(&descriptor)
                .map_err(internal_error)?
            {
                return Err(McpError::invalid_params(
                    format!("unknown resource `{}`", request.uri),
                    None,
                ));
            }
            serde_json::to_value(descriptor).map_err(|error| internal_error(error.to_string()))?
        } else {
            return Err(McpError::invalid_params(
                format!("unknown resource `{}`", request.uri),
                None,
            ));
        };
        let text = serde_json::to_string_pretty(&value)
            .map_err(|error| internal_error(error.to_string()))?;
        Ok(ReadResourceResult::new(vec![
            ResourceContents::text(text, request.uri).with_mime_type("application/json"),
        ]))
    }

    fn subscribe(
        &self,
        request: SubscribeRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<(), McpError>> + Send + '_ {
        let result = if self.resource_exists(&request.uri) {
            self.subscriptions
                .write()
                .map_err(|_| internal_error("subscription lock was poisoned"))
                .map(|mut subscriptions| {
                    subscriptions.insert(request.uri);
                })
        } else {
            Err(McpError::invalid_params(
                format!("unknown resource `{}`", request.uri),
                None,
            ))
        };
        std::future::ready(result)
    }

    fn unsubscribe(
        &self,
        request: UnsubscribeRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<(), McpError>> + Send + '_ {
        let result = self
            .subscriptions
            .write()
            .map_err(|_| internal_error("subscription lock was poisoned"))
            .map(|mut subscriptions| {
                subscriptions.remove(&request.uri);
            });
        std::future::ready(result)
    }

    fn on_initialized(
        &self,
        context: NotificationContext<RoleServer>,
    ) -> impl Future<Output = ()> + Send + '_ {
        let mut events = self.registry.subscribe();
        let peer = context.peer.clone();
        let subscriptions = self.subscriptions.clone();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(RegistryEvent::CapabilityRegistered { .. })
                    | Ok(RegistryEvent::CapabilityRemoved { .. }) => {
                        let _ = peer.notify_tool_list_changed().await;
                        let _ = peer.notify_resource_list_changed().await;
                        let manifest_is_subscribed = subscriptions
                            .read()
                            .is_ok_and(|subscriptions| subscriptions.contains(MANIFEST_URI));
                        if manifest_is_subscribed {
                            let _ = peer
                                .notify_resource_updated(
                                    rmcp::model::ResourceUpdatedNotificationParam::new(
                                        MANIFEST_URI,
                                    ),
                                )
                                .await;
                        }
                    }
                    Ok(RegistryEvent::ResourcesChanged { uris, .. }) => {
                        let subscribed = subscriptions
                            .read()
                            .map(|subscriptions| subscriptions.clone())
                            .unwrap_or_default();
                        for uri in uris {
                            if subscribed.contains(&uri) {
                                let _ = peer
                                    .notify_resource_updated(
                                        rmcp::model::ResourceUpdatedNotificationParam::new(uri),
                                    )
                                    .await;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = peer.notify_tool_list_changed().await;
                        let _ = peer.notify_resource_list_changed().await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        std::future::ready(())
    }
}

fn capability_tool(descriptor: CapabilityDescriptor) -> Tool {
    let mut meta = Map::new();
    meta.insert(
        "opencut/capabilityId".into(),
        Value::String(descriptor.id.clone()),
    );
    meta.insert(
        "opencut/capabilityVersion".into(),
        Value::String(descriptor.version.clone()),
    );
    meta.insert(
        "opencut/category".into(),
        Value::String(descriptor.category.clone()),
    );
    meta.insert(
        "opencut/available".into(),
        Value::Bool(descriptor.available),
    );
    if let Some(reason) = &descriptor.unavailable_reason {
        meta.insert(
            "opencut/unavailableReason".into(),
            Value::String(reason.clone()),
        );
    }

    let input_schema = capability_input_schema(&descriptor);
    Tool::new(
        Cow::Owned(format!("{TOOL_PREFIX}{}", descriptor.id)),
        Cow::Owned(descriptor.description),
        Arc::new(input_schema),
    )
    .with_title(descriptor.title.clone())
    .with_raw_output_schema(Arc::new(invocation_receipt_schema(
        descriptor.output_schema,
    )))
    .with_annotations(
        ToolAnnotations::with_title(descriptor.title)
            .read_only(descriptor.access == AccessLevel::Read)
            .destructive(descriptor.access >= AccessLevel::Destructive)
            .idempotent(descriptor.idempotent)
            .open_world(descriptor.open_world),
    )
    .with_meta(rmcp::model::Meta(meta))
}

fn fixed_tools() -> Vec<Tool> {
    vec![
        fixed_tool(
            DISCOVER_TOOL,
            "Discover OpenCut capabilities",
            "Search the live OpenCut Editor API by text, category, and maximum access level. Newly registered app features appear automatically.",
            json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "category": {"type": "string"},
                    "maxAccess": {"type": "string", "enum": ["read", "write", "destructive", "admin"]}
                },
                "additionalProperties": false
            }),
            true,
        ),
        fixed_tool(
            DESCRIBE_TOOL,
            "Describe an OpenCut capability",
            "Return the exact versioned input/output schemas and safety metadata for one capability.",
            json!({
                "type": "object",
                "properties": {"capabilityId": {"type": "string"}},
                "required": ["capabilityId"],
                "additionalProperties": false
            }),
            true,
        ),
        fixed_tool(
            INVOKE_TOOL,
            "Invoke any OpenCut capability",
            "Late-bound universal invocation surface. Use when a client cached its tool list before a new app capability was registered.",
            json!({
                "type": "object",
                "properties": {
                    "capabilityId": {"type": "string"},
                    "input": {"type": "object"},
                    "dryRun": {
                        "type": "boolean",
                        "default": false,
                        "description": "Ask the capability to validate or preview without committing, when supported."
                    }
                },
                "required": ["capabilityId"],
                "additionalProperties": false
            }),
            false,
        ),
        fixed_tool(
            BATCH_TOOL,
            "Run an OpenCut capability batch",
            "Run an ordered list of Editor API operations, optionally continuing after individual failures.",
            json!({
                "type": "object",
                "properties": {
                    "calls": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 256,
                        "items": {
                            "type": "object",
                            "properties": {
                                "capabilityId": {"type": "string"},
                                "input": {"type": "object"},
                                "dryRun": {"type": "boolean", "default": false}
                            },
                            "required": ["capabilityId"],
                            "additionalProperties": false
                        }
                    },
                    "stopOnError": {"type": "boolean", "default": true}
                    ,
                    "mode": {
                        "type": "string",
                        "enum": ["atomic", "bestEffort"],
                        "default": "atomic",
                        "description": "Atomic rolls back the complete batch on failure and creates one undo entry."
                    }
                },
                "required": ["calls"],
                "additionalProperties": false
            }),
            false,
        ),
    ]
}

fn capability_input_schema(descriptor: &CapabilityDescriptor) -> Map<String, Value> {
    let mut schema = schema_object(descriptor.input_schema.clone());
    if descriptor.access == AccessLevel::Read {
        return schema;
    }
    let properties = schema
        .entry("properties")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .expect("validated capability object schemas must have object properties");
    properties.entry("idempotencyKey").or_insert_with(|| {
        json!({
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "description": "Caller-generated key that makes retries return the original receipt."
        })
    });
    properties.entry("expectedRevision").or_insert_with(|| {
        json!({
            "type": "integer",
            "minimum": 0,
            "description": "Reject the write if the targeted project no longer has this revision."
        })
    });
    if requires_project_target(&descriptor.id) {
        properties.entry("projectId").or_insert_with(|| {
            json!({
                "type": "string",
                "minLength": 1,
                "description": "Explicit OpenCut project session targeted by this write."
            })
        });
        let required = schema
            .entry("required")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .expect("required must be an array");
        if !required
            .iter()
            .any(|item| item.as_str() == Some("projectId"))
        {
            required.push(Value::String("projectId".into()));
        }
    }
    schema
}

fn apply_invocation_envelope(
    descriptor: &CapabilityDescriptor,
    arguments: &mut Map<String, Value>,
    context: &mut InvocationContext,
) -> Result<(), String> {
    if descriptor.access == AccessLevel::Read {
        return Ok(());
    }
    let declared = descriptor
        .input_schema
        .get("properties")
        .and_then(Value::as_object);
    let project_id = arguments.get("projectId").and_then(Value::as_str);
    // Protocol v2 advertises projectId as required. For one compatibility
    // release, older clients that omit it still target the sole active tab.
    if let Some(project_id) = project_id {
        context.metadata.insert(
            "opencut/projectId".into(),
            Value::String(project_id.to_owned()),
        );
        if !declared.is_some_and(|properties| properties.contains_key("projectId")) {
            arguments.remove("projectId");
        }
    }
    if let Some(expected_revision) = arguments.get("expectedRevision").and_then(Value::as_u64) {
        context.metadata.insert(
            "opencut/expectedRevision".into(),
            Value::Number(expected_revision.into()),
        );
        if !declared.is_some_and(|properties| properties.contains_key("expectedRevision")) {
            arguments.remove("expectedRevision");
        }
    }
    if let Some(idempotency_key) = arguments
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        context.metadata.insert(
            "opencut/idempotencyKey".into(),
            Value::String(idempotency_key),
        );
        if !declared.is_some_and(|properties| properties.contains_key("idempotencyKey")) {
            arguments.remove("idempotencyKey");
        }
    }
    Ok(())
}

fn requires_project_target(id: &str) -> bool {
    !matches!(id, "project.create" | "project.open" | "project.activate")
}

fn fixed_tool(
    name: &'static str,
    title: &'static str,
    description: &'static str,
    input_schema: Value,
    read_only: bool,
) -> Tool {
    Tool::new(
        Cow::Borrowed(name),
        Cow::Borrowed(description),
        Arc::new(schema_object(input_schema)),
    )
    .with_title(title)
    .with_annotations(
        ToolAnnotations::with_title(title)
            .read_only(read_only)
            .destructive(false)
            .idempotent(read_only)
            .open_world(false),
    )
}

fn schema_object(schema: Value) -> Map<String, Value> {
    schema.as_object().cloned().unwrap_or_else(|| {
        Map::from_iter([
            ("type".into(), Value::String("object".into())),
            ("additionalProperties".into(), Value::Bool(false)),
        ])
    })
}

fn invocation_receipt_schema(capability_output_schema: Value) -> Map<String, Value> {
    schema_object(json!({
        "type": "object",
        "properties": {
            "capabilityId": {"type": "string"},
            "capabilityVersion": {"type": "string"},
            "registryRevision": {"type": "integer"},
            "result": {
                "type": "object",
                "properties": {
                    "data": capability_output_schema,
                    "summary": {"type": ["string", "null"]},
                    "changedResources": {"type": "array", "items": {"type": "string"}},
                    "artifacts": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "uri": {"type": "string"},
                                "mimeType": {"type": "string"},
                                "byteSize": {"type": "integer"},
                                "sha256": {"type": "string"},
                                "createdAtMs": {"type": "integer"},
                                "expiresAtMs": {"type": "integer"},
                                "width": {"type": ["integer", "null"]},
                                "height": {"type": ["integer", "null"]},
                                "durationMs": {"type": ["integer", "null"]}
                            },
                            "required": [
                                "id", "uri", "mimeType", "byteSize", "sha256",
                                "createdAtMs", "expiresAtMs", "width", "height", "durationMs"
                            ]
                        }
                    }
                },
                "required": ["data", "summary", "changedResources", "artifacts"]
            }
        },
        "required": ["capabilityId", "capabilityVersion", "registryRevision", "result"]
    }))
}

fn structured_success(value: Value) -> CallToolResult {
    CallToolResult::structured(value)
}

fn structured_failure(error: RegistryError) -> CallToolResult {
    structured_message_failure(registry_error_code(&error), error.to_string())
}

fn structured_message_failure(
    code: impl Into<String>,
    message: impl Into<String>,
) -> CallToolResult {
    CallToolResult::structured_error(json!({
        "error": code.into(),
        "message": message.into()
    }))
}

fn registry_error_code(error: &RegistryError) -> &'static str {
    match error {
        RegistryError::NotFound(_) => "capability_not_found",
        RegistryError::InvalidInput { .. } => "invalid_input",
        RegistryError::InvalidOutput { .. } => "invalid_capability_output",
        RegistryError::Denied(_) => "access_denied",
        RegistryError::Capability(opencut_editor_api::CapabilityError::Conflict(_)) => "conflict",
        RegistryError::Capability(_) => "capability_failed",
        _ => "internal_error",
    }
}

fn parse_access(value: &str) -> Option<AccessLevel> {
    match value {
        "read" => Some(AccessLevel::Read),
        "write" => Some(AccessLevel::Write),
        "destructive" => Some(AccessLevel::Destructive),
        "admin" => Some(AccessLevel::Admin),
        _ => None,
    }
}

fn mcp_invocation_context(context: &RequestContext<RoleServer>, source: &str) -> InvocationContext {
    InvocationContext {
        source: source.into(),
        actor: context
            .peer
            .peer_info()
            .map(|client| format!("{}@{}", client.client_info.name, client.client_info.version)),
        request_id: Some(context.id.to_string()),
        cancellation: context.ct.clone(),
        ..Default::default()
    }
}

fn internal_error(error: impl ToString) -> McpError {
    McpError::internal_error(error.to_string(), None)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use opencut_editor_api::{
        CapabilityDescriptor, CapabilityResult, FnCapability, OpenCutRuntime,
    };
    use serde_json::json;

    use super::*;

    #[test]
    fn all_editor_capabilities_become_direct_mcp_tools() {
        let runtime = OpenCutRuntime::default();
        let server = OpenCutMcp::new(runtime.registry().clone());
        let names: Vec<_> = server
            .tools()
            .unwrap()
            .into_iter()
            .map(|tool| tool.name.into_owned())
            .collect();

        assert!(names.contains(&"opencut.app.capabilities.list".into()));
        assert!(names.contains(&"opencut.app.state.read".into()));
        assert!(names.contains(&"opencut.project.create".into()));
        assert!(names.contains(&"opencut.timeline.text.update".into()));
        assert!(names.contains(&"opencut.media.probe".into()));
        assert!(names.contains(&"opencut.preview.frame.render".into()));
        assert!(names.contains(&"opencut.export.render".into()));
        assert!(names.contains(&DISCOVER_TOOL.into()));
        assert!(names.contains(&INVOKE_TOOL.into()));
        assert!(
            names.len() >= 35,
            "expected complete editor surface, got {} tools",
            names.len()
        );
    }

    #[test]
    fn capability_registered_after_server_creation_appears_without_adapter_changes() {
        let runtime = OpenCutRuntime::default();
        let server = OpenCutMcp::new(runtime.registry().clone());
        let before = server.tools().unwrap().len();

        runtime
            .register(Arc::new(FnCapability::new(
                CapabilityDescriptor::read(
                    "timeline.clip.inspect",
                    "Inspect clip",
                    "Returns one timeline clip",
                    "timeline",
                    json!({"type": "object"}),
                    json!({"type": "object"}),
                ),
                |_, _| Box::pin(async { Ok(CapabilityResult::data(json!({}))) }),
            )))
            .unwrap();

        let tools = server.tools().unwrap();
        assert_eq!(tools.len(), before + 1);
        assert!(
            tools
                .iter()
                .any(|tool| tool.name == "opencut.timeline.clip.inspect")
        );
    }

    #[tokio::test]
    async fn classic_mutations_are_not_routed_through_rewrite_project_sessions() {
        let runtime = OpenCutRuntime::default();
        let server = OpenCutMcp::from_runtime(&runtime);
        let mut descriptor = CapabilityDescriptor::read(
            "classic.timeline.edit_source",
            "Classic edit",
            "Routes an edit to the connected Classic browser.",
            "classic",
            json!({"type": "object"}),
            json!({"type": "object"}),
        );
        descriptor.access = AccessLevel::Write;
        let arguments = json!({"projectId": "classic-browser-project"})
            .as_object()
            .expect("arguments")
            .clone();

        server
            .activate_target_if_needed(&descriptor, &arguments, &InvocationContext::default())
            .await
            .expect("Classic project targeting is validated by the browser bridge");
    }

    #[tokio::test]
    async fn generated_mcp_tools_edit_the_same_runtime_read_by_the_app() {
        let runtime = OpenCutRuntime::default();
        let server = OpenCutMcp::new(runtime.registry().clone());
        server
            .call_generated_capability(
                "project.create",
                json!({"name": "Live MCP edit"})
                    .as_object()
                    .expect("arguments")
                    .clone(),
                InvocationContext {
                    source: "mcp-test".into(),
                    ..InvocationContext::default()
                },
            )
            .await;
        let text_track = runtime
            .snapshot()
            .expect("snapshot")
            .project
            .as_ref()
            .expect("project")
            .timeline
            .tracks
            .iter()
            .find(|track| track.kind == opencut_editor_api::TrackKind::Text)
            .expect("text track")
            .id
            .clone();
        server
            .call_generated_capability(
                "timeline.item.add",
                json!({
                    "trackId": text_track,
                    "name": "Agent title",
                    "kind": "text",
                    "startSeconds": 0.0,
                    "durationSeconds": 3.0
                })
                .as_object()
                .expect("arguments")
                .clone(),
                InvocationContext {
                    source: "mcp-test".into(),
                    ..InvocationContext::default()
                },
            )
            .await;

        let title_id = runtime
            .snapshot()
            .expect("snapshot")
            .project
            .as_ref()
            .expect("project")
            .timeline
            .tracks
            .iter()
            .flat_map(|track| &track.items)
            .find(|item| item.name == "Agent title")
            .expect("MCP-created title")
            .id
            .clone();
        server
            .call_generated_capability(
                "timeline.text.update",
                json!({
                    "itemId": title_id,
                    "patch": {"content": "Visible live"}
                })
                .as_object()
                .expect("arguments")
                .clone(),
                InvocationContext {
                    source: "mcp-test".into(),
                    ..InvocationContext::default()
                },
            )
            .await;
        let snapshot = runtime.snapshot().expect("snapshot");
        let title = snapshot
            .project
            .as_ref()
            .expect("project")
            .timeline
            .tracks
            .iter()
            .flat_map(|track| &track.items)
            .find(|item| item.id == title_id)
            .expect("MCP-edited title");
        assert_eq!(title.text.as_ref().expect("text").content, "Visible live");
    }

    #[tokio::test]
    async fn http_transport_rejects_unsafe_binding_and_weak_tokens() {
        let runtime = OpenCutRuntime::default();
        let error = serve_authenticated_http(
            runtime.registry().clone(),
            "0.0.0.0:32123".parse().unwrap(),
            "a-strong-token-with-more-than-32-characters",
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);

        let error = serve_authenticated_http(
            runtime.registry().clone(),
            "127.0.0.1:0".parse().unwrap(),
            "too-short",
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn atomic_batch_rolls_back_and_creates_no_partial_edit() {
        let runtime = OpenCutRuntime::default();
        runtime
            .registry()
            .invoke(
                "project.create",
                InvocationContext::default(),
                json!({"name": "Before"}),
            )
            .await
            .unwrap();
        let project_id = runtime.snapshot().unwrap().project.unwrap().id;
        let server = OpenCutMcp::from_runtime(&runtime);
        let result = server
            .call_batch(
                json!({
                    "mode": "atomic",
                    "calls": [
                        {
                            "capabilityId": "project.update",
                            "input": {
                                "projectId": project_id,
                                "patch": {"name": "Should roll back"}
                            }
                        },
                        {
                            "capabilityId": "timeline.item.update",
                            "input": {
                                "projectId": project_id,
                                "id": "missing-item",
                                "patch": {"name": "Nope"}
                            }
                        }
                    ]
                })
                .as_object()
                .unwrap()
                .clone(),
                InvocationContext::default(),
            )
            .await;
        assert_eq!(
            result.structured_content.as_ref().unwrap()["committed"],
            false
        );
        assert_eq!(runtime.snapshot().unwrap().project.unwrap().name, "Before");
    }

    #[tokio::test]
    async fn artifact_results_include_mcp_image_content() {
        let runtime = OpenCutRuntime::default();
        let artifact = runtime
            .artifacts()
            .put(vec![137, 80, 78, 71], "image/png", Some(1), Some(1), None)
            .unwrap();
        runtime
            .register(Arc::new(FnCapability::new(
                CapabilityDescriptor::read(
                    "test.image",
                    "Test image",
                    "Returns an image artifact",
                    "test",
                    json!({"type": "object"}),
                    json!({"type": "object"}),
                ),
                move |_, _| {
                    let artifact = artifact.clone();
                    Box::pin(async move {
                        Ok(CapabilityResult {
                            data: json!({}),
                            summary: None,
                            changed_resources: Vec::new(),
                            artifacts: vec![artifact],
                        })
                    })
                },
            )))
            .unwrap();
        let server = OpenCutMcp::from_runtime(&runtime);
        let result = server
            .call_generated_capability("test.image", Map::new(), InvocationContext::default())
            .await;
        assert!(
            result
                .content
                .iter()
                .any(|content| matches!(content, ContentBlock::Image(_)))
        );
    }

    #[tokio::test]
    async fn preview_capture_targets_an_inactive_project_without_activating_it() {
        if std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_err()
        {
            return;
        }
        let runtime = OpenCutRuntime::default();
        runtime
            .registry()
            .invoke(
                "project.create",
                InvocationContext::default(),
                json!({"name": "First"}),
            )
            .await
            .unwrap();
        let first_id = runtime.snapshot().unwrap().project.unwrap().id;
        runtime
            .registry()
            .invoke(
                "project.create",
                InvocationContext::default(),
                json!({"name": "Second"}),
            )
            .await
            .unwrap();
        let second_id = runtime.snapshot().unwrap().project.unwrap().id;
        let server = OpenCutMcp::from_runtime(&runtime);
        let result = server
            .call_generated_capability(
                "preview.frame.capture",
                json!({
                    "projectId": first_id,
                    "width": 160,
                    "height": 90,
                    "format": "png"
                })
                .as_object()
                .unwrap()
                .clone(),
                InvocationContext::default(),
            )
            .await;
        assert!(
            result
                .content
                .iter()
                .any(|content| matches!(content, ContentBlock::Image(_)))
        );
        assert_eq!(
            runtime.snapshot().unwrap().project.unwrap().id,
            second_id,
            "a targeted read must not change the active project"
        );
    }
}
