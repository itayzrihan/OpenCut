//! Launches durable canonical scene intents through the existing bounded batch host.
//! Queueing and publication remain undoable automation.edit transactions; this
//! non-transactional host capability only starts, observes, or cancels that work.
use super::*;
use crate::{CapabilityDescriptor, FnCapability, HostBridge, OpenCutRuntime};
use serde_json::json;

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    #[schemars(regex(
        pattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
    ))]
    project_id: String,
    expected_revision: u64,
    #[schemars(regex(
        pattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
    ))]
    job_id: String,
    /// Explicitly resume an interrupted/failed job at its saved stage. Never
    /// silently retries completed or cancelled work.
    #[serde(default)]
    resume: bool,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
enum Status {
    NotStarted,
    Queued,
    Importing,
    Ready,
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    Published,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Output {
    project_id: String,
    revision: u64,
    job_id: String,
    worker_project_id: String,
    output_scene_id: String,
    action: String,
    status: Status,
    #[schemars(range(min = 0, max = 20))]
    completed_stages: u32,
    cancel_requested: bool,
    published: bool,
    #[schemars(length(max = 1000))]
    message: String,
}
fn bad(message: impl Into<String>) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}

fn valid_host_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                *b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
        && matches!(bytes[14], b'1'..=b'8')
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

pub fn register_classic_automation_host(
    runtime: &OpenCutRuntime,
    bridge: &HostBridge,
) -> Result<(), RegistryError> {
    for (id, operation, title, access) in [
        (
            "project.classic.automation.start",
            "start",
            "Start a queued automatic scene edit",
            AccessLevel::Write,
        ),
        (
            "project.classic.automation.status",
            "status",
            "Read automatic scene edit progress",
            AccessLevel::Write,
        ),
        (
            "project.classic.automation.cancel",
            "cancel",
            "Cancel an automatic scene edit",
            AccessLevel::Write,
        ),
    ] {
        let mut descriptor = CapabilityDescriptor::read(
            id,
            title,
            match operation {
                "start" => {
                    "Launch ONE existing canonical scene job. First enqueue with project.classic.automation.edit change.type=enqueue: choose action sound-effects for Earshot; word-animation for word animation/reveal plus procedural Earshot sounds; or full-auto with options.soundEffects=true. Every recipe requires zoom, transitions, wordAnimation, music booleans; soundEffects defaults false. Supply unique UUID job/worker/output identities. Then use the returned revision and jobId here. Saves that immutable worker and starts the existing background queue without changing the viewer scene. Returns queued/running status, NOT completed AI work; poll project.classic.automation.status. Reuse the same jobId after a lost reply: never enqueues duplicate jobs or overwrites a progressed worker. resume=true only resumes a failed/interrupted job from its durable stage. If the source changed before initial startup completed, queue a fresh job instead. AI/provider and linked media IO are open-world and may continue after a lost reply; inspect the same job, never invent a replacement automatically. No arbitrary code on the server. Async, non-transactional, no dryRun; cancellation stops startup checks but use .cancel to stop an accepted job. The editor must stay open for its background worker. Results publish as a NEW scene through the existing canonical automation transaction."
                }
                "status" => {
                    "Read one existing canonical scene job's actual batch execution status, completedStages and cancellation flag. The canonical jobId is the durable identity across exact retries; published means its result was canonically added as a new scene. not-started means no execution journal exists yet. Does not start, resume, publish or mutate the job. Requires current projectId and expectedRevision; no raw filesystem paths. Requires Write authority because the host reads account-owned filesystem queue IO; does not mutate the project."
                }
                _ => {
                    "Request cooperative cancellation of ONE existing canonical scene job in the existing execution queue. Does not delete source scenes, working copies, media or saved checkpoints; completed publication remains intact. Reusing jobId is safe. This is an external queue action, not an undoable timeline edit. A lost response may mean cancellation was accepted: query .status for the same jobId. No dryRun. Cancelling the startup invocation alone does not stop an already accepted background job."
                }
            },
            "automation",
            schema::<Input>(),
            schema::<Output>(),
        );
        descriptor.access = access;
        descriptor.document_support = DocumentSupport::Classic;
        descriptor.open_world = true;
        descriptor.cancellable = true;
        descriptor.idempotent = true;
        descriptor.tags = vec![
            "classic".into(),
            "automation".into(),
            "earshot".into(),
            "sound-effects".into(),
            "word-animation".into(),
            "full-auto".into(),
            "batch".into(),
        ];
        let rt = runtime.downgrade();
        let host = bridge.clone();
        runtime.registry().register(Arc::new(FnCapability::new(descriptor.clone(), move |context, input| {
            let rt = rt.clone();
            let host = host.clone();
            Box::pin(async move {
                let rt = rt().ok_or_else(|| CapabilityError::Unavailable("Editor runtime closed".into()))?;
                let args: Input = serde_json::from_value(input).map_err(|e| bad(e.to_string()))?;
                if context.dry_run || args.job_id.is_empty() || args.job_id.len() > 160 || (operation != "start" && args.resume) {
                    return Err(bad("Invalid automation host request; use a committed queue intent and no dryRun"));
                }
                let scope = || {
                    if context.cancellation.is_cancelled() { return Err(CapabilityError::Failed("Automation invocation cancelled; query the same job to reconcile accepted work".into())); }
                    let state = rt.snapshot().map_err(|e| CapabilityError::Failed(e.to_string()))?;
                    if state.revision != args.expected_revision || context.metadata.get("opencut/projectId").is_some_and(|v| v.as_str() != Some(&args.project_id)) {
                        return Err(CapabilityError::Conflict("Automation project or revision changed; reconcile the same jobId".into()));
                    }
                    let classic = state.project.as_ref().filter(|p| p.id == args.project_id).and_then(|p| p.classic.as_ref())
                        .ok_or_else(|| CapabilityError::Conflict("Automation project changed".into()))?;
                    super::classic_automation::queued_job_snapshot(classic, &args.project_id, &args.job_id)
                };
                let (job, worker) = scope()?;
                if !valid_host_id(&args.project_id) || !valid_host_id(&args.job_id) || !job["workerProjectId"].as_str().is_some_and(valid_host_id) {
                    return Err(bad("Scene execution storage requires UUID project, job and worker identities; enqueue a UUID-scoped job before any host IO"));
                }
                if !matches!(job["action"].as_str(), Some("sound-effects" | "word-animation" | "full-auto")) {
                    return Err(bad("This host starts Earshot, word reveal, or Full Auto scene jobs"));
                }
                let request = json!({"operation":operation,"input":args,"job":job,"worker":if operation == "start" {worker} else {None}});
                let result = if operation == "status" {
                    host.execute_cancellable_preflight(id, "sceneAutomation", &args.project_id, request, None, context.cancellation.clone()).await?
                } else {
                    host.execute(id, "sceneAutomation", &args.project_id, request).await?
                };
                let (current, _) = scope()?;
                let out: Output = serde_json::from_value(result.data.clone()).map_err(|e| bad(e.to_string()))?;
                if out.project_id != args.project_id || out.revision != args.expected_revision || out.job_id != args.job_id
                    || current["workerProjectId"] != out.worker_project_id || current["outputSceneId"] != out.output_scene_id
                    || current["action"] != out.action || out.completed_stages > 20 || out.message.len() > 1000
                    || out.published != (current["status"] == "published") {
                    return Err(CapabilityError::Conflict("Automation host reply differs from the queued intent".into()));
                }
                Ok(result)
            })
        })))?;
        bridge
            .install(&descriptor)
            .map_err(RegistryError::Capability)?;
    }
    Ok(())
}
