use std::{
    future::Future,
    task::{Context, Poll, Waker},
};

use opencut_editor_api::{
    AccessLevel, CapabilityDescriptor, CapabilityExecution, DocumentKind, InvocationReceipt,
    OpenCutRuntime, RegistrySnapshot,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    AgentError, AgentRun, AgentScope, CapabilityMatch, PlanStep, RunPhase, ToolOutcome,
    discover_capabilities,
};

/// Local runtime adapter. It shares the editor's actual runtime and never
/// accepts model-supplied observations or commit receipts. Remote/long-running
/// hosts use AgentRun's explicit pending/reconcile protocol instead.
pub struct RuntimeAgent {
    pub(crate) runtime: OpenCutRuntime,
    pub(crate) run: AgentRun,
    pub(crate) provider: crate::provider::ProviderState,
    pub(crate) host: Option<opencut_editor_api::HostBridge>,
    pub(crate) suspended: Option<
        std::pin::Pin<
            Box<
                dyn Future<Output = Result<InvocationReceipt, opencut_editor_api::RegistryError>>
                    + Send,
            >,
        >,
    >,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentCommand {
    Observe,
    Discover {
        query: String,
        limit: usize,
    },
    Describe {
        epoch: u64,
        id: String,
    },
    Plan {
        epoch: u64,
        steps: Vec<PlanStep>,
    },
    Invoke {
        epoch: u64,
        call_id: String,
        id: String,
        input: Value,
    },
    Steer {
        text: String,
    },
    Pause,
    Resume {
        scope: AgentScope,
    },
    Finish {
        epoch: u64,
        text: String,
    },
    Fail {
        epoch: u64,
        text: String,
    },
}

impl RuntimeAgent {
    /// Only the authenticated host installs previous public conversation.
    pub fn load_conversation(
        &mut self,
        archive: &crate::ConversationArchive,
    ) -> Result<(), AgentError> {
        self.provider.conversation = archive.prior_context(
            &self.run.scope().account_id,
            &self.run.scope().project_id,
            self.run.request(),
        )?;
        Ok(())
    }
    pub fn load_knowledge(
        &mut self,
        account_id: &str,
        project_id: &str,
        knowledge: crate::knowledge::KnowledgeContext,
    ) -> Result<(), AgentError> {
        if account_id != self.run.scope().account_id || project_id != self.run.scope().project_id {
            return Err(AgentError::Denied(
                "knowledge context belongs to another editing scope".into(),
            ));
        }
        knowledge.validate_scope(project_id)?;
        if self
            .provider
            .knowledge
            .as_ref()
            .is_none_or(|old| old.revision != knowledge.revision)
        {
            self.run.invalidate_verification();
        }
        self.provider.knowledge = Some(knowledge);
        Ok(())
    }
    pub fn new(
        runtime: OpenCutRuntime,
        scope: AgentScope,
        request: String,
        max_access: AccessLevel,
    ) -> Result<Self, AgentError> {
        let document = runtime.snapshot().map_err(runtime_error)?;
        let project = document.project.as_ref().ok_or_else(|| {
            AgentError::Conflict("open a project before starting the editing agent".into())
        })?;
        if project.id != scope.project_id {
            return Err(AgentError::Denied(
                "agent target is not the active project".into(),
            ));
        }
        let kind = if project.classic.is_some() {
            DocumentKind::Classic
        } else {
            DocumentKind::Rewrite
        };
        let mut run = AgentRun::new(scope, kind, request, max_access, false)?;
        run.observe(document.revision)?;
        Ok(Self {
            runtime,
            run,
            provider: Default::default(),
            host: None,
            suspended: None,
        })
    }

    /// Installed by the editor host, never selected through model arguments.
    /// Only exact descriptors installed in this bridge gain external access.
    pub fn with_host_bridge(mut self, bridge: opencut_editor_api::HostBridge) -> Self {
        self.run.allow_host_effects();
        self.host = Some(bridge);
        self
    }

    pub fn run(&self) -> &AgentRun {
        &self.run
    }

    pub fn model_action(
        &mut self,
        epoch: u64,
        call_id: &str,
        action: crate::ModelAction,
    ) -> Result<Value, AgentError> {
        if epoch != self.run.epoch()
            || !matches!(
                self.run.phase(),
                RunPhase::Ready | RunPhase::NeedsVerification
            )
        {
            return Err(AgentError::Conflict(
                "provider turn was superseded or the editor needs observation".into(),
            ));
        }
        self.command(action.bind(epoch, call_id)?)
    }

    pub fn command(&mut self, command: AgentCommand) -> Result<Value, AgentError> {
        match command {
            AgentCommand::Observe => self.observe(),
            AgentCommand::Discover { query, limit } => {
                serde_json::to_value(self.discover(&query, limit)?).map_err(runtime_error)
            }
            AgentCommand::Describe { epoch, id } => {
                serde_json::to_value(self.describe(epoch, &id)?).map_err(runtime_error)
            }
            AgentCommand::Plan { epoch, steps } => {
                self.plan(epoch, steps)?;
                Ok(Value::Null)
            }
            AgentCommand::Invoke {
                epoch,
                call_id,
                id,
                input,
            } => {
                let descriptor = self
                    .runtime
                    .registry()
                    .descriptor(&id)
                    .map_err(runtime_error)?;
                if descriptor
                    .as_ref()
                    .is_some_and(|d| self.host.as_ref().is_some_and(|h| h.supports(d)))
                {
                    self.invoke_host(epoch, &call_id, &id, input)
                } else {
                    serde_json::to_value(self.invoke_immediate(epoch, &call_id, &id, input)?)
                        .map_err(runtime_error)
                }
            }
            AgentCommand::Steer { text } => {
                self.steer(text)?;
                Ok(Value::Null)
            }
            AgentCommand::Pause => {
                self.pause();
                Ok(Value::Null)
            }
            AgentCommand::Resume { scope } => {
                self.resume(&scope)?;
                Ok(Value::Null)
            }
            AgentCommand::Finish { epoch, text } => {
                self.finish(epoch, text)?;
                Ok(Value::Null)
            }
            AgentCommand::Fail { epoch, text } => {
                self.kind()?;
                self.run.fail(epoch, text)?;
                Ok(Value::Null)
            }
        }
    }

    pub fn catalog(&self) -> Result<RegistrySnapshot, AgentError> {
        let mut catalog = self.runtime.registry().snapshot().map_err(runtime_error)?;
        for descriptor in &mut catalog.capabilities {
            if descriptor.access > self.run.max_access() {
                descriptor.available = false;
                descriptor.unavailable_reason =
                    Some("This capability exceeds the editing run's granted authority".into());
                continue;
            }
            if !self
                .host
                .as_ref()
                .is_some_and(|host| host.supports(descriptor))
                && (descriptor.open_world
                    || descriptor.execution != CapabilityExecution::Immediate
                    || (descriptor.access != AccessLevel::Read && !descriptor.transactional))
            {
                descriptor.available = false;
                descriptor.unavailable_reason = Some("This host requires an asynchronous or external-effect adapter for this capability".into());
            }
        }
        Ok(catalog)
    }

    fn kind(&self) -> Result<DocumentKind, AgentError> {
        let document = self.runtime.snapshot().map_err(runtime_error)?;
        let project = document
            .project
            .as_ref()
            .ok_or_else(|| AgentError::Conflict("editor was closed".into()))?;
        if project.id != self.run.scope().project_id {
            return Err(AgentError::Conflict("editor target changed".into()));
        }
        Ok(if project.classic.is_some() {
            DocumentKind::Classic
        } else {
            DocumentKind::Rewrite
        })
    }

    fn invoke_host(
        &mut self,
        epoch: u64,
        call_id: &str,
        id: &str,
        input: Value,
    ) -> Result<Value, AgentError> {
        self.kind()?;
        if self.run.revision() != Some(self.runtime.snapshot().map_err(runtime_error)?.revision) {
            return Err(AgentError::Conflict(
                "editor changed before host dispatch; observe again".into(),
            ));
        }
        let pending = self
            .run
            .prepare_tool(epoch, &self.catalog()?, call_id, id, input)?;
        let registry = self.runtime.registry().clone();
        let id = id.to_owned();
        self.suspended = Some(Box::pin(async move {
            registry
                .invoke(&id, pending.invocation.context, pending.invocation.input)
                .await
        }));
        match self.poll_host()? {
            Some(result) => result,
            None => Ok(serde_json::json!({"pendingHost":true})),
        }
    }

    pub fn pending_host_effect(
        &self,
    ) -> Result<Option<opencut_editor_api::HostEffect>, AgentError> {
        let effects = self
            .host
            .as_ref()
            .map(|host| host.pending())
            .transpose()
            .map_err(runtime_error)?
            .unwrap_or_default();
        Ok(effects.into_iter().next())
    }

    /// Host IO may finish after pause/steering. Retain its true receipt without
    /// resuming the run or accepting more buffered provider actions.
    pub(crate) fn poll_host(&mut self) -> Result<Option<Result<Value, AgentError>>, AgentError> {
        let Some(future) = self.suspended.as_mut() else {
            return Err(AgentError::Conflict(
                "no host invocation is suspended".into(),
            ));
        };
        let Poll::Ready(result) = future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        else {
            return Ok(None);
        };
        self.suspended = None;
        let pending = self
            .run
            .pending()
            .cloned()
            .ok_or_else(|| AgentError::Conflict("missing pending host receipt".into()))?;
        let revision = self.runtime.snapshot().map_err(runtime_error)?.revision;
        let outcome = match &result {
            Ok(receipt) if pending.invocation.mutating && revision == pending.expected_revision => {
                ToolOutcome::ExternalApplied {
                    revision,
                    artifact_ids: receipt
                        .result
                        .artifacts
                        .iter()
                        .map(|a| a.id.clone())
                        .collect(),
                }
            }
            Ok(receipt) if pending.invocation.mutating => ToolOutcome::Applied {
                revision,
                artifact_ids: receipt
                    .result
                    .artifacts
                    .iter()
                    .map(|a| a.id.clone())
                    .collect(),
            },
            Ok(receipt) => ToolOutcome::Read {
                revision,
                artifact_ids: receipt
                    .result
                    .artifacts
                    .iter()
                    .map(|a| a.id.clone())
                    .collect(),
            },
            Err(error) => ToolOutcome::Rejected {
                revision,
                message: error.to_string(),
            },
        };
        self.run.settle_tool(&pending.call_id, outcome)?;
        if self.run.phase() != RunPhase::Paused {
            self.observe()?;
        }
        Ok(Some(result.map_err(runtime_error).and_then(|receipt| {
            serde_json::to_value(receipt).map_err(runtime_error)
        })))
    }

    pub fn observe(&mut self) -> Result<Value, AgentError> {
        self.kind()?;
        let state = self.runtime.snapshot().map_err(runtime_error)?;
        self.run.observe(state.revision)?;
        serde_json::to_value(state).map_err(runtime_error)
    }

    pub fn discover(&self, query: &str, limit: usize) -> Result<Vec<CapabilityMatch>, AgentError> {
        Ok(discover_capabilities(
            &self.catalog()?,
            self.kind()?,
            query,
            limit,
        ))
    }

    pub fn describe(&mut self, epoch: u64, id: &str) -> Result<CapabilityDescriptor, AgentError> {
        self.kind()?;
        self.run.describe(epoch, &self.catalog()?, id)
    }

    pub fn plan(&mut self, epoch: u64, steps: Vec<PlanStep>) -> Result<(), AgentError> {
        self.run.set_plan(epoch, steps)
    }
    pub fn steer(&mut self, text: String) -> Result<(), AgentError> {
        self.run.steer(text)?;
        self.provider.reset_turn_window();
        Ok(())
    }
    pub fn pause(&mut self) {
        self.run.pause();
    }
    pub fn resume(&mut self, authenticated_scope: &AgentScope) -> Result<(), AgentError> {
        self.kind()?;
        self.run.resume(authenticated_scope)?;
        self.provider.reset_turn_window();
        Ok(())
    }

    /// A transaction encloses the capability and its target postcondition. A
    /// project lifecycle tool cannot replace the run's document accidentally.
    /// The UI host projects the committed result after this method returns.
    pub fn invoke_immediate(
        &mut self,
        epoch: u64,
        call_id: &str,
        id: &str,
        input: Value,
    ) -> Result<InvocationReceipt, AgentError> {
        let kind = self.kind()?;
        let catalog = self.catalog()?;
        if catalog
            .capabilities
            .iter()
            .find(|d| d.id == id)
            .is_some_and(|d| d.execution != CapabilityExecution::Immediate || d.open_world)
        {
            return Err(AgentError::Denied(
                "use the registered host adapter for this capability".into(),
            ));
        }
        let mut pending = self.run.prepare_tool(epoch, &catalog, call_id, id, input)?;
        let checkpoint = match self.runtime.begin_atomic() {
            Ok(checkpoint) => checkpoint,
            Err(error) => {
                self.run.settle_tool(
                    call_id,
                    ToolOutcome::Rejected {
                        revision: pending.expected_revision,
                        message: error.to_string(),
                    },
                )?;
                return Err(runtime_error(error));
            }
        };
        if pending.invocation.mutating {
            pending
                .invocation
                .context
                .metadata
                .insert("opencut/transaction".into(), Value::Bool(true));
        }
        let result = {
            let mut future = std::pin::pin!(self.runtime.registry().invoke(
                id,
                pending.invocation.context,
                pending.invocation.input
            ));
            match future
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
            {
                Poll::Ready(result) => result.map_err(runtime_error),
                Poll::Pending => Err(AgentError::Conflict(
                    "immediate capability unexpectedly suspended".into(),
                )),
            }
        };
        let result = result.and_then(|receipt| {
            if self.kind()? != kind {
                return Err(AgentError::Denied(
                    "capability attempted to replace the agent's document representation".into(),
                ));
            }
            Ok(receipt)
        });
        match result {
            Ok(receipt) => {
                if pending.invocation.mutating {
                    if let Err(error) = self
                        .runtime
                        .commit_atomic(checkpoint.clone(), format!("Agent: {id}"))
                    {
                        self.runtime
                            .rollback_atomic(checkpoint)
                            .map_err(runtime_error)?;
                        self.run.settle_tool(
                            call_id,
                            ToolOutcome::Rejected {
                                revision: pending.expected_revision,
                                message: error.to_string(),
                            },
                        )?;
                        self.observe()?;
                        return Err(runtime_error(error));
                    }
                }
                let state = self.runtime.snapshot().map_err(runtime_error)?;
                let artifact_ids = receipt
                    .result
                    .artifacts
                    .iter()
                    .map(|a| a.id.clone())
                    .collect();
                self.run.settle_tool(
                    call_id,
                    if pending.invocation.mutating {
                        ToolOutcome::Applied {
                            revision: state.revision,
                            artifact_ids,
                        }
                    } else {
                        ToolOutcome::Read {
                            revision: state.revision,
                            artifact_ids,
                        }
                    },
                )?;
                self.run.observe(state.revision)?;
                Ok(receipt)
            }
            Err(error) => {
                self.runtime
                    .rollback_atomic(checkpoint)
                    .map_err(runtime_error)?;
                self.run.settle_tool(
                    call_id,
                    ToolOutcome::Rejected {
                        revision: self.runtime.snapshot().map_err(runtime_error)?.revision,
                        message: error.to_string(),
                    },
                )?;
                self.observe()?;
                Err(error)
            }
        }
    }

    /// Called by the host QA adapter after inspecting the current rendered
    /// artifacts. Never expose this method as a model tool that can self-attest.
    pub fn verify(
        &mut self,
        epoch: u64,
        revision: u64,
        issues: &[String],
    ) -> Result<(), AgentError> {
        self.kind()?;
        if self.runtime.snapshot().map_err(runtime_error)?.revision != revision {
            return Err(AgentError::Conflict(
                "editor changed after verification".into(),
            ));
        }
        self.run.verify(epoch, revision, issues)
    }

    pub fn finish(&mut self, epoch: u64, text: String) -> Result<(), AgentError> {
        self.kind()?;
        if self.run.revision() != Some(self.runtime.snapshot().map_err(runtime_error)?.revision) {
            return Err(AgentError::Conflict(
                "editor changed; inspect and verify again".into(),
            ));
        }
        self.run.finish(epoch, text)
    }

    pub fn is_closed(&self) -> bool {
        matches!(self.run.phase(), RunPhase::Completed | RunPhase::Failed)
    }
}

fn runtime_error(error: impl std::fmt::Display) -> AgentError {
    AgentError::Conflict(error.to_string())
}
