use super::*;
use opencut_editor_agent::{AgentCommand, AgentScope, RuntimeAgent};
use opencut_editor_api::AccessLevel;

#[wasm_bindgen]
impl CanonicalEditorRuntime {
    #[wasm_bindgen(js_name=providerRetryPlan)]
    pub fn provider_retry_plan(&self, failure: JsValue) -> Result<JsValue,JsValue> {
        to_js(&opencut_editor_agent::provider_retry_plan(from_json_input(failure)?).map_err(js_error)?)
    }
    #[wasm_bindgen(js_name=storeInputAttachment)]
    pub fn store_input_attachment(&self,project_id:String,filename:String,bytes:Vec<u8>,mime_type:String)->Result<JsValue,JsValue> {
        self.check_conversation_scope(&project_id)?;
        if bytes.len()>2_000_000 {return Err(js_error("Attachment exceeds the two-megabyte request budget"));}
        let artifact=self.runtime.artifacts().put(bytes,mime_type,None,None,None).map_err(js_error)?;
        let reference=opencut_editor_agent::InputAttachment{artifact_id:artifact.id.clone(),filename};
        if let Err(error)=opencut_editor_agent::validate_attachments(self.runtime.artifacts(),std::slice::from_ref(&reference)) {
            let _=self.runtime.artifacts().remove(&artifact.id);return Err(js_error(error));
        }
        to_js(&reference)
    }
    #[wasm_bindgen(js_name=agentInputAttachments)]
    pub fn agent_input_attachments(&self,account_id:String,project_id:String,attachments:JsValue)->Result<(),JsValue> {
        let attachments=serde_wasm_bindgen::from_value(attachments).map_err(js_error)?;
        self.agent.borrow_mut().as_mut().ok_or_else(||js_error("Start an editing run first"))?.set_input_attachments(&account_id,&project_id,attachments).map_err(js_error)
    }
    #[wasm_bindgen(js_name=conversationArtifacts)]
    pub fn conversation_artifacts(&self,account_id:String,project_id:String)->Result<JsValue,JsValue> {
        self.check_conversation_scope(&project_id)?;
        let mut ids=std::collections::BTreeSet::new();
        ids.extend(self.runtime.referenced_artifact_ids(&project_id).map_err(js_error)?);
        if let Some(conversation)=self.conversation.borrow().as_ref() {
            conversation.validate(&account_id,&project_id).map_err(js_error)?;
            for entry in &conversation.entries {
                ids.extend(entry.attachments.iter().map(|a|a.artifact_id.clone()));
                ids.extend(entry.artifact_ids.iter().cloned());
                if let Some(export)=&entry.export {ids.insert(export.artifact_id.clone());}
            }
        }
        if let Some(agent)=self.agent.borrow().as_ref() {
            if agent.run().scope().account_id!=account_id||agent.run().scope().project_id!=project_id {return Err(js_error("Artifact run scope changed"));}
            for receipt in agent.run().receipts(){ids.extend(receipt.artifact_ids.iter().cloned());}
        }
        let (available,unavailable_ids):(Vec<_>,Vec<_>)=ids.into_iter().partition(|id|self.runtime.artifacts().get(id).is_ok());
        for id in &available {self.runtime.artifacts().pin(id).map_err(js_error)?;}
        let archive=self.runtime.artifacts().archive(&available).map_err(js_error)?;
        to_js(&opencut_editor_agent::ScopedArtifactArchive{account_id,project_id,archive,unavailable_ids})
    }
    #[wasm_bindgen(js_name=restoreConversationArtifacts)]
    pub fn restore_conversation_artifacts(&self,account_id:String,project_id:String,archive:JsValue)->Result<(),JsValue> {
        self.check_conversation_scope(&project_id)?;
        let archive:opencut_editor_agent::ScopedArtifactArchive=serde_wasm_bindgen::from_value(archive).map_err(js_error)?;
        archive.restore(&account_id,&project_id,self.runtime.artifacts()).map_err(js_error)
    }
    #[wasm_bindgen(js_name=conversationRead)]
    pub fn conversation_read(&self,account_id:String,project_id:String)->Result<JsValue,JsValue> {
        self.check_conversation_scope(&project_id)?;
        if let Some(state)=self.conversation.borrow().as_ref(){state.validate(&account_id,&project_id).map_err(js_error)?;}
        to_js(&*self.conversation.borrow())
    }
    #[wasm_bindgen(js_name=conversationApply)]
    pub fn conversation_apply(&self,account_id:String,project_id:String,event:JsValue)->Result<JsValue,JsValue> {
        self.check_conversation_scope(&project_id)?;
        let event:opencut_editor_agent::ConversationEvent=serde_wasm_bindgen::from_value(event).map_err(js_error)?;
        if let opencut_editor_agent::ConversationEvent::User{attachments,..}=&event {
            opencut_editor_agent::validate_attachments(self.runtime.artifacts(),attachments).map_err(js_error)?;
            for item in attachments {self.runtime.artifacts().pin(&item.artifact_id).map_err(js_error)?;}
        }
        let mut state=self.conversation.borrow_mut();
        let current=state.get_or_insert_with(||opencut_editor_agent::ConversationArchive::new(account_id.clone(),project_id.clone()));
        current.apply(&account_id,&project_id,event).map_err(js_error)?;
        to_js(&*state)
    }
    #[wasm_bindgen(js_name=conversationRestore)]
    pub fn conversation_restore(&self,account_id:String,project_id:String,archive:JsValue)->Result<JsValue,JsValue> {
        self.check_conversation_scope(&project_id)?;
        if self.conversation.borrow().is_some(){return Err(js_error("Restore conversation into a fresh session"));}
        let state:opencut_editor_agent::ConversationArchive=serde_wasm_bindgen::from_value(archive).map_err(js_error)?;
        let state=state.restore(&account_id,&project_id).map_err(js_error)?;
        *self.conversation.borrow_mut()=Some(state);
        to_js(&*self.conversation.borrow())
    }
    /// Opaque run record. Persist with the canonical archive of the same
    /// revision; it is not independently sufficient to restore an editor.
    #[wasm_bindgen(js_name = agentCheckpoint)]
    pub fn agent_checkpoint(&self)->Result<JsValue,JsValue>{
        if self.transaction.borrow().is_some(){return Err(js_error("Finish the editor transaction before checkpointing"));}
        match self.agent.borrow().as_ref(){Some(agent)=>Ok(JsValue::from_str(&agent.checkpoint().map_err(js_error)?)),None=>Ok(JsValue::NULL)}
    }
    #[wasm_bindgen(js_name = agentRestoreCheckpoint)]
    pub fn agent_restore_checkpoint(&self,account_id:String,checkpoint:String)->Result<JsValue,JsValue>{
        if self.transaction.borrow().is_some() || self.agent.borrow().is_some(){return Err(js_error("Restore into a fresh editor session"));}
        let project_id=self.runtime.snapshot().map_err(js_error)?.project.ok_or_else(||js_error("Restore the canonical project first"))?.id;
        let agent=RuntimeAgent::restore_checkpoint(self.runtime.clone(),&account_id,&project_id,AccessLevel::Write,Some(self.host.clone()),&checkpoint).map_err(js_error)?;
        let view=to_js(agent.run())?;
        *self.agent.borrow_mut()=Some(agent);
        Ok(view)
    }
    #[wasm_bindgen(js_name = agentPendingHost)]
    pub fn agent_pending_host(&self)->Result<JsValue,JsValue>{
        to_js(&self.agent.borrow().as_ref().ok_or_else(||js_error("Start an editing run first"))?.pending_host_effect().map_err(js_error)?)
    }
    #[wasm_bindgen(js_name = agentSettleHost)]
    pub fn agent_settle_host(&self,account_id:String,project_id:String,effect_id:f64,result:JsValue)->Result<JsValue,JsValue>{
        if self.transaction.borrow().is_some(){return Err(js_error("Finish the editor transaction first"));}
        if !effect_id.is_finite() || effect_id<0.0 || effect_id.fract()!=0.0 || effect_id>9_007_199_254_740_991.0{return Err(js_error("Invalid host effect identity"));}
        let result=serde_wasm_bindgen::from_value(result).map_err(js_error)?;
        to_js(&self.agent.borrow_mut().as_mut().ok_or_else(||js_error("Start an editing run first"))?.settle_host_effect(&account_id,&project_id,effect_id as u64,result).map_err(js_error)?)
    }
    #[wasm_bindgen(js_name = agentKnowledge)]
    pub fn agent_knowledge(&self,account_id:String,project_id:String,context:JsValue)->Result<(),JsValue>{
        let context=serde_wasm_bindgen::from_value(context).map_err(js_error)?;
        self.agent.borrow_mut().as_mut().ok_or_else(||js_error("Start an editing run first"))?.load_knowledge(&account_id,&project_id,context).map_err(js_error)
    }
    #[wasm_bindgen(js_name = agentReviewPlan)]
    pub fn agent_review_plan(&self) -> Result<JsValue, JsValue> {
        to_js(&self.agent.borrow().as_ref().ok_or_else(|| js_error("Start an editing run first"))?.review_plan().map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = agentReviewRequest)]
    pub fn agent_review_request(&self, model: String, epoch: u32, revision: JsValue, frames: JsValue) -> Result<JsValue, JsValue> {
        if self.transaction.borrow().is_some() { return Err(js_error("Finish the editor transaction first")); }
        let revision = serde_wasm_bindgen::from_value(revision).map_err(js_error)?;
        let frames = serde_wasm_bindgen::from_value(frames).map_err(js_error)?;
        to_js(&self.agent.borrow_mut().as_mut().ok_or_else(|| js_error("Start an editing run first"))?.review_request(&model,epoch as u64,revision,frames).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = agentReviewResponse)]
    pub fn agent_review_response(&self, epoch: u32, response: JsValue) -> Result<JsValue, JsValue> {
        if self.transaction.borrow().is_some() { return Err(js_error("Finish the editor transaction first")); }
        let response = serde_wasm_bindgen::from_value(response).map_err(js_error)?;
        to_js(&self.agent.borrow_mut().as_mut().ok_or_else(|| js_error("Start an editing run first"))?.review_response(epoch as u64,response).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = agentProviderRequest)]
    pub fn agent_provider_request(&self, model: String) -> Result<JsValue, JsValue> {
        if self.transaction.borrow().is_some() { return Err(js_error("Finish the editor transaction first")); }
        let mut agent = self.agent.borrow_mut();
        to_js(&agent.as_mut().ok_or_else(|| js_error("Start an editing run first"))?.provider_request(&model).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = agentProviderResponse)]
    pub fn agent_provider_response(&self, epoch: u32, response: JsValue) -> Result<JsValue, JsValue> {
        if self.transaction.borrow().is_some() { return Err(js_error("Finish the editor transaction first")); }
        let response = serde_wasm_bindgen::from_value(response).map_err(js_error)?;
        let mut agent = self.agent.borrow_mut();
        to_js(&agent.as_mut().ok_or_else(|| js_error("Start an editing run first"))?.provider_response(epoch as u64, response).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = agentModelSchema)]
    pub fn agent_model_schema(&self) -> Result<JsValue, JsValue> {
        to_js(&opencut_editor_agent::model_action_schema())
    }

    #[wasm_bindgen(js_name = agentModelAction)]
    pub fn agent_model_action(
        &self,
        epoch: u32,
        call_id: String,
        action: JsValue,
    ) -> Result<JsValue, JsValue> {
        if self.transaction.borrow().is_some() {
            return Err(js_error(
                "Finish the editor transaction before invoking an agent action",
            ));
        }
        let action = serde_wasm_bindgen::from_value(action).map_err(js_error)?;
        let mut agent = self.agent.borrow_mut();
        let agent = agent
            .as_mut()
            .ok_or_else(|| js_error("Start an editing run first"))?;
        to_js(
            &agent
                .model_action(epoch as u64, &call_id, action)
                .map_err(js_error)?,
        )
    }

    /// The account comes from the authenticated editor host, never model text.
    /// Reuses this instance's canonical document, registry and undo history.
    #[wasm_bindgen(js_name = agentStart)]
    pub fn agent_start(
        &self,
        account_id: String,
        run_id: String,
        request: String,
    ) -> Result<JsValue, JsValue> {
        if self.transaction.borrow().is_some() {
            return Err(js_error(
                "Finish the editor transaction before starting an agent",
            ));
        }
        if self
            .agent
            .borrow()
            .as_ref()
            .is_some_and(|agent| !agent.is_closed())
        {
            return Err(js_error(
                "An editing run already exists; steer or resume it",
            ));
        }
        let state = self.runtime.snapshot().map_err(js_error)?;
        let project = state
            .project
            .ok_or_else(|| js_error("Open a project before starting an agent"))?;
        let mut agent = RuntimeAgent::new(
            self.runtime.clone(),
            AgentScope {
                account_id,
                project_id: project.id,
                run_id,
            },
            request,
            AccessLevel::Write,
        )
        .map_err(js_error)?.with_host_bridge(self.host.clone());
        if let Some(archive) = self.conversation.borrow().as_ref() {
            agent.load_conversation(archive).map_err(js_error)?;
        }
        let view = to_js(agent.run())?;
        *self.agent.borrow_mut() = Some(agent);
        Ok(view)
    }

    #[wasm_bindgen(js_name = agentCommand)]
    pub fn agent_command(&self, command: JsValue) -> Result<JsValue, JsValue> {
        if self.transaction.borrow().is_some() {
            return Err(js_error(
                "Finish the editor transaction before invoking an agent command",
            ));
        }
        let command: AgentCommand = serde_wasm_bindgen::from_value(command).map_err(js_error)?;
        let mut agent = self.agent.borrow_mut();
        let agent = agent
            .as_mut()
            .ok_or_else(|| js_error("Start an editing run first"))?;
        to_js(&agent.command(command).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = agentSnapshot)]
    pub fn agent_snapshot(&self) -> Result<JsValue, JsValue> {
        match self.agent.borrow().as_ref() {
            Some(agent) => to_js(agent.run()),
            None => Ok(JsValue::NULL),
        }
    }

    /// Host QA entry point, intentionally absent from model commands.
    #[wasm_bindgen(js_name = agentVerify)]
    pub fn agent_verify(
        &self,
        epoch: u32,
        revision: JsValue,
        issues: JsValue,
    ) -> Result<(), JsValue> {
        let revision: u64 = serde_wasm_bindgen::from_value(revision).map_err(js_error)?;
        let issues: Vec<String> = serde_wasm_bindgen::from_value(issues).map_err(js_error)?;
        self.agent
            .borrow_mut()
            .as_mut()
            .ok_or_else(|| js_error("Start an editing run first"))?
            .verify(epoch as u64, revision, &issues)
            .map_err(js_error)
    }
}

impl CanonicalEditorRuntime {
    fn check_conversation_scope(&self,project_id:&str)->Result<(),JsValue> {
        if self.runtime.snapshot().map_err(js_error)?.project.as_ref().map(|p|p.id.as_str())!=Some(project_id) {return Err(js_error("Conversation project changed"));}
        Ok(())
    }
}
