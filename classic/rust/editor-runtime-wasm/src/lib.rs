//! Browser binding for the canonical editor; no browser-only document model.

#![cfg(target_arch = "wasm32")]

use opencut_editor_api::{InvocationContext, OpenCutRuntime, RuntimeCheckpoint};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct InvocationOptions {
    dry_run: bool,
    request_id: Option<String>,
    metadata: Map<String, Value>,
}

/// One instance belongs to the editor host, never to a composition iframe.
#[wasm_bindgen]
pub struct CanonicalEditorRuntime {
    runtime: OpenCutRuntime,
    transaction: RefCell<Option<RuntimeCheckpoint>>,
}

#[wasm_bindgen]
impl CanonicalEditorRuntime {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<CanonicalEditorRuntime, JsValue> {
        Ok(Self {
            runtime: OpenCutRuntime::full_access().map_err(js_error)?,
            transaction: RefCell::new(None),
        })
    }

    /// Invokes the live registry, including validation, revisions and history.
    /// Omit context or pass {dryRun, requestId, metadata} when required.
    pub async fn invoke(
        &self,
        capability_id: String,
        input: JsValue,
        context: JsValue,
    ) -> Result<JsValue, JsValue> {
        if self.transaction.borrow().is_some() {
            return Err(js_error(
                "Use synchronous capabilities inside a Classic transaction",
            ));
        }
        let input: Value = serde_wasm_bindgen::from_value(input).map_err(js_error)?;
        let context = invocation_context(context)?;
        let receipt = self
            .runtime
            .registry()
            .invoke(&capability_id, context, input)
            .await
            .map_err(js_error)?;
        to_js(&receipt)
    }

    /// Classic's command stack is synchronous. These built-in handlers perform
    /// only in-memory work and do not suspend; all validation/history still runs
    /// through the same registry. Async/native/plugin work must use invoke().
    #[wasm_bindgen(js_name = invokeSync)]
    pub fn invoke_sync(
        &self,
        capability_id: String,
        input: JsValue,
        context: JsValue,
    ) -> Result<JsValue, JsValue> {
        use std::{
            future::Future,
            task::{Context, Poll, Waker},
        };
        if !matches!(
            capability_id.as_str(),
            "project.classic.attach"
                | "project.classic.session.attach"
                | "project.classic.session.read"
                | "project.classic.session.status"
                | "project.classic.session.archive"
                | "project.classic.session.restore"
                | "project.classic.commit"
                | "project.classic.synchronize"
                | "hyperframes.project.inspect"
                | "hyperframes.package.plan"
                | "hyperframes.manifest.validate"
                | "hyperframes.manifest.set"
                | "hyperframes.audio.prepare"
                | "hyperframes.audio.clips.read"
                | "timeline.hyperframes.import"
                | "app.state.read"
                | "history.undo"
                | "history.redo"
        ) {
            return Err(js_error(
                "This capability is not an immediate Classic transaction; use invoke()",
            ));
        }
        let input = serde_wasm_bindgen::from_value(input).map_err(js_error)?;
        let mut context = invocation_context(context)?;
        if self.transaction.borrow().is_some() {
            let descriptor = self
                .runtime
                .registry()
                .descriptor(&capability_id)
                .map_err(js_error)?;
            if !descriptor.is_some_and(|descriptor| descriptor.transactional) {
                return Err(js_error(
                    "This capability cannot run inside an atomic transaction",
                ));
            }
            context
                .metadata
                .insert("opencut/transaction".into(), Value::Bool(true));
        }
        let mut future = std::pin::pin!(self.runtime.registry().invoke(
            &capability_id,
            context,
            input
        ));
        match future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(result) => to_js(&result.map_err(js_error)?),
            Poll::Pending => Err(js_error("Immediate capability unexpectedly suspended")),
        }
    }

    /// Groups synchronous Classic mutations into one canonical undo entry.
    /// The host must commit or roll back before yielding to its event loop.
    #[wasm_bindgen(js_name = beginTransaction)]
    pub fn begin_transaction(
        &self,
        project_id: &str,
        expected_revision: JsValue,
    ) -> Result<(), JsValue> {
        if self.transaction.borrow().is_some() {
            return Err(js_error("A Classic transaction is already active"));
        }
        let expected_revision: u64 =
            serde_wasm_bindgen::from_value(expected_revision).map_err(js_error)?;
        let current = self.runtime.snapshot().map_err(js_error)?;
        if current.revision != expected_revision {
            return Err(js_error("Classic transaction revision conflict"));
        }
        if !current
            .project
            .as_ref()
            .is_some_and(|project| project.id == project_id && project.classic.is_some())
        {
            return Err(js_error("Classic target project is not active"));
        }
        *self.transaction.borrow_mut() = Some(self.runtime.begin_atomic().map_err(js_error)?);
        Ok(())
    }

    #[wasm_bindgen(js_name = commitTransaction)]
    pub fn commit_transaction(
        &self,
        label: &str,
        host_context: JsValue,
    ) -> Result<JsValue, JsValue> {
        if label.trim().is_empty() {
            return Err(js_error("Transaction label must not be empty"));
        }
        let host_context = if host_context.is_null() || host_context.is_undefined() {
            Map::new()
        } else {
            serde_wasm_bindgen::from_value(host_context).map_err(js_error)?
        };
        let checkpoint = self
            .transaction
            .borrow()
            .clone()
            .ok_or_else(|| js_error("No Classic transaction is active"))?;
        let revision = self
            .runtime
            .commit_atomic_with_context(checkpoint, label, host_context)
            .map_err(js_error)?;
        self.transaction.borrow_mut().take();
        to_js(&revision)
    }

    #[wasm_bindgen(js_name = rollbackTransaction)]
    pub fn rollback_transaction(&self) -> Result<(), JsValue> {
        let checkpoint = self
            .transaction
            .borrow()
            .clone()
            .ok_or_else(|| js_error("No Classic transaction is active"))?;
        self.runtime.rollback_atomic(checkpoint).map_err(js_error)?;
        self.transaction.borrow_mut().take();
        Ok(())
    }

    /// Read-only projection of the exact document returned by app.state.read.
    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        to_js(&self.runtime.snapshot().map_err(js_error)?)
    }

    pub fn capabilities(&self) -> Result<JsValue, JsValue> {
        to_js(&self.runtime.registry().snapshot().map_err(js_error)?)
    }

    /// The host persists these bytes through its existing storage service.
    pub fn serialize(&self) -> Result<Vec<u8>, JsValue> {
        if self.transaction.borrow().is_some() {
            return Err(js_error("Finish the Classic transaction before persisting"));
        }
        self.runtime.serialize_application_state().map_err(js_error)
    }

    /// Restores a previously serialized session after full model validation.
    pub fn restore(&self, bytes: &[u8]) -> Result<(), JsValue> {
        if self.transaction.borrow().is_some() {
            return Err(js_error("Finish the Classic transaction before restoring"));
        }
        self.runtime
            .restore_application_state_from_bytes(bytes)
            .map_err(js_error)
    }

    /// Binary results are accessed by bounded ArtifactStore ID/URI, never a path.
    /// This host-only adapter publishes renderer output; it does not mutate the
    /// editor document or register a transport-specific editor capability.
    #[wasm_bindgen(js_name = storeArtifact)]
    pub fn store_artifact(
        &self,
        bytes: &[u8],
        mime_type: &str,
        width: Option<u32>,
        height: Option<u32>,
        duration_ms: Option<u64>,
    ) -> Result<JsValue, JsValue> {
        let artifact = self
            .runtime
            .artifacts()
            .put(bytes.to_vec(), mime_type, width, height, duration_ms)
            .map_err(js_error)?;
        to_js(&artifact)
    }

    #[wasm_bindgen(js_name = removeArtifact)]
    pub fn remove_artifact(&self, id_or_uri: &str) -> Result<bool, JsValue> {
        self.runtime.artifacts().remove(id_or_uri).map_err(js_error)
    }

    #[wasm_bindgen(js_name = readArtifact)]
    pub fn read_artifact(&self, id_or_uri: &str) -> Result<Vec<u8>, JsValue> {
        Ok(self
            .runtime
            .artifacts()
            .get(id_or_uri)
            .map_err(js_error)?
            .bytes
            .to_vec())
    }
}

fn to_js(value: &impl Serialize) -> Result<JsValue, JsValue> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(js_error)
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&error.to_string()).into()
}

fn invocation_context(value: JsValue) -> Result<InvocationContext, JsValue> {
    let options: InvocationOptions = if value.is_null() || value.is_undefined() {
        InvocationOptions::default()
    } else {
        serde_wasm_bindgen::from_value(value).map_err(js_error)?
    };
    Ok(InvocationContext {
        source: "classic.web".into(),
        dry_run: options.dry_run,
        request_id: options.request_id,
        metadata: options.metadata,
        ..InvocationContext::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wasm_bindgen_test::wasm_bindgen_test;

    fn from_js(value: JsValue) -> Value {
        serde_wasm_bindgen::from_value(value).unwrap()
    }

    async fn call(runtime: &CanonicalEditorRuntime, id: &str, input: Value) -> Value {
        from_js(
            runtime
                .invoke(id.into(), to_js(&input).unwrap(), JsValue::UNDEFINED)
                .await
                .unwrap(),
        )["result"]["data"]
            .clone()
    }

    fn message(error: JsValue) -> String {
        js_sys::Reflect::get(&error, &"message".into())
            .unwrap()
            .as_string()
            .unwrap()
    }

    #[wasm_bindgen_test]
    fn browser_transaction_groups_edits_and_rolls_back_failed_commands() {
        let runtime = CanonicalEditorRuntime::new().unwrap();
        let mut classic: Value = serde_json::from_str(include_str!(
            "../../../../crates/editor-api/tests/fixtures/classic-project.json"
        ))
        .unwrap();
        let call = |id: &str, input: Value| {
            from_js(
                runtime
                    .invoke_sync(id.into(), to_js(&input).unwrap(), JsValue::UNDEFINED)
                    .unwrap(),
            )["result"]["data"]
                .clone()
        };
        call(
            "project.classic.attach",
            json!({"projectId":"classic-project", "expectedRevision":0, "classic":classic}),
        );
        let before = from_js(runtime.snapshot().unwrap());
        assert!(
            runtime
                .begin_transaction("wrong-project", to_js(&1).unwrap())
                .is_err()
        );
        runtime
            .begin_transaction("classic-project", to_js(&1).unwrap())
            .unwrap();
        assert!(
            runtime
                .begin_transaction("classic-project", to_js(&1).unwrap())
                .is_err()
        );
        assert!(runtime.serialize().is_err());
        assert!(
            runtime
                .invoke_sync(
                    "history.undo".into(),
                    to_js(&json!({})).unwrap(),
                    JsValue::UNDEFINED
                )
                .is_err()
        );
        classic["document"]["metadata"]["name"] = json!("First part");
        call(
            "project.classic.commit",
            json!({"projectId":"classic-project", "expectedRevision":1, "classic":classic}),
        );
        classic["document"]["metadata"]["name"] = json!("Second part");
        call(
            "project.classic.commit",
            json!({"projectId":"classic-project", "expectedRevision":2, "classic":classic}),
        );
        runtime
            .commit_transaction(
                "Compound command",
                to_js(&json!({"callbackId":"compound"})).unwrap(),
            )
            .unwrap();
        let undo = call("history.undo", json!({}));
        assert_eq!(undo["canUndo"], false);
        assert_eq!(undo["hostContext"]["callbackId"], "compound");
        assert_eq!(
            from_js(runtime.snapshot().unwrap())["project"],
            before["project"]
        );
        let revision = from_js(runtime.snapshot().unwrap())["revision"].clone();
        runtime
            .begin_transaction("classic-project", to_js(&revision).unwrap())
            .unwrap();
        call(
            "project.classic.commit",
            json!({"projectId":"classic-project", "expectedRevision":revision, "classic":classic}),
        );
        runtime.rollback_transaction().unwrap();
        assert_eq!(
            from_js(runtime.snapshot().unwrap())["project"],
            before["project"]
        );
        assert_eq!(
            call(
                "project.classic.session.read",
                json!({"projectId":"classic-project"})
            )["redoStack"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let archive = call(
            "project.classic.session.archive",
            json!({"projectId":"classic-project"}),
        );
        let restored = CanonicalEditorRuntime::new().unwrap();
        restored.invoke_sync("project.classic.session.restore".into(), to_js(&json!({"projectId":"classic-project", "expectedRevision":0, "archive":archive})).unwrap(), JsValue::UNDEFINED).unwrap();
        assert_eq!(
            from_js(restored.snapshot().unwrap())["project"],
            before["project"]
        );
    }

    #[wasm_bindgen_test]
    fn existing_history_crosses_the_synchronous_browser_boundary() {
        let runtime = CanonicalEditorRuntime::new().unwrap();
        let classic: Value = serde_json::from_str(include_str!(
            "../../../../crates/editor-api/tests/fixtures/classic-project.json"
        ))
        .unwrap();
        let mut previous = classic.clone();
        previous["document"]["metadata"]["name"] = json!("Before edit");
        let call = |id: &str, input: Value| {
            from_js(
                runtime
                    .invoke_sync(id.into(), to_js(&input).unwrap(), JsValue::UNDEFINED)
                    .unwrap(),
            )["result"]["data"]
                .clone()
        };
        call(
            "project.classic.session.attach",
            json!({"projectId":"classic-project", "expectedRevision":0, "classic":classic,
            "undoStack":[{"label":"Existing edit", "classic":previous, "hostContext":{"callbackId":"browser-command"}}]}),
        );
        let history = call(
            "project.classic.session.read",
            json!({"projectId":"classic-project"}),
        );
        assert_eq!(history["undoStack"][0]["classic"], previous);
        let undo = call("history.undo", json!({}));
        assert_eq!(undo["hostContext"]["callbackId"], "browser-command");
        assert_eq!(
            from_js(runtime.snapshot().unwrap())["project"]["classic"],
            previous
        );
        call("history.redo", json!({}));
        assert_eq!(
            from_js(runtime.snapshot().unwrap())["project"]["classic"],
            classic
        );
    }

    #[wasm_bindgen_test]
    fn synchronous_classic_transactions_keep_existing_scene_data() {
        let runtime = CanonicalEditorRuntime::new().unwrap();
        let classic: Value = serde_json::from_str(include_str!(
            "../../../../crates/editor-api/tests/fixtures/classic-project.json"
        ))
        .unwrap();
        let call = |id: &str, input: Value| {
            from_js(
                runtime
                    .invoke_sync(id.into(), to_js(&input).unwrap(), JsValue::UNDEFINED)
                    .unwrap(),
            )["result"]["data"]
                .clone()
        };
        call(
            "project.classic.attach",
            json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
        );
        call(
            "timeline.hyperframes.import",
            json!({"projectId":"classic-project","expectedRevision":1,"name":"Composition","source":{"entryFile":"index.html","files":{"index.html":"<div data-composition-id='main' data-duration='6'></div>"},"resourceAssetIds":{}}}),
        );
        let read = call("app.state.read", json!({}));
        assert_eq!(
            read["value"]["project"]["classic"]["document"]["scenes"][0]["tracks"]["main"],
            classic["document"]["scenes"][0]["tracks"]["main"]
        );
        call("history.undo", json!({}));
        assert_eq!(
            from_js(runtime.snapshot().unwrap())["project"]["classic"],
            classic
        );
        call("history.redo", json!({}));
        assert_eq!(
            from_js(runtime.snapshot().unwrap())["project"],
            read["value"]["project"]
        );
        let updated = from_js(runtime.snapshot().unwrap());
        call(
            "project.classic.commit",
            json!({"projectId":"classic-project","expectedRevision":updated["revision"],"classic":classic}),
        );
        assert_eq!(
            from_js(runtime.snapshot().unwrap())["project"]["classic"],
            classic
        );
        assert!(
            runtime
                .invoke_sync(
                    "job.start".into(),
                    to_js(&json!({})).unwrap(),
                    JsValue::UNDEFINED
                )
                .is_err()
        );
    }

    #[wasm_bindgen_test]
    async fn browser_import_uses_canonical_revisions_history_and_persistence() {
        let runtime = CanonicalEditorRuntime::new().unwrap();
        call(
            &runtime,
            "project.create",
            json!({"name":"Mixed browser project"}),
        )
        .await;
        let asset = call(&runtime, "media.import", json!({"name":"Native video","source":"opencut-media://original","mediaType":"video","durationSeconds":12})).await;
        let initial = from_js(runtime.snapshot().unwrap());
        let project_id = &initial["project"]["id"];
        let track_id = &initial["project"]["timeline"]["tracks"][0]["id"];
        call(&runtime, "timeline.item.add", json!({"trackId":track_id,"kind":"video","name":"Original edit","assetId":asset["changedIds"][0],"startSeconds":0,"durationSeconds":12})).await;
        let before = from_js(runtime.snapshot().unwrap());
        let before_bytes = runtime.serialize().unwrap();
        let source = json!({
            "entryFile":"index.html",
            "files":{"index.html":"<!doctype html><div data-composition-id='main' data-width='720' data-height='1280' data-duration='6'><div data-start='0' data-duration='6'>שלום</div><script>throw new Error('inspection must not execute source');</script></div>"},
            "resourceAssetIds":{}
        });
        let input = json!({"projectId":project_id,"expectedRevision":before["revision"],"name":"Brag composition","source":source,"startSeconds":2});
        let options = json!({"dryRun":true,"requestId":"browser-import","metadata":{"opencut/idempotencyKey":"browser-import"}});
        let dry = from_js(
            runtime
                .invoke(
                    "timeline.hyperframes.import".into(),
                    to_js(&input).unwrap(),
                    to_js(&options).unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_eq!(dry["result"]["data"]["mutation"]["committed"], false);
        assert_eq!(from_js(runtime.snapshot().unwrap()), before);
        let mut options = options;
        options["dryRun"] = json!(false);
        let committed = runtime
            .invoke(
                "timeline.hyperframes.import".into(),
                to_js(&input).unwrap(),
                to_js(&options).unwrap(),
            )
            .await
            .unwrap();
        let retry = runtime
            .invoke(
                "timeline.hyperframes.import".into(),
                to_js(&input).unwrap(),
                to_js(&options).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(from_js(retry), from_js(committed));

        let after = from_js(runtime.snapshot().unwrap());
        assert_eq!(
            after["project"]["timeline"]["tracks"][0],
            before["project"]["timeline"]["tracks"][0]
        );
        assert_eq!(
            after["project"]["assets"][1]["hyperframes"]["source"],
            source
        );
        assert_eq!(after["project"]["settings"], before["project"]["settings"]);
        let read = call(&runtime, "app.state.read", json!({"projectId":project_id})).await;
        assert_eq!(read["value"], after);
        let stale = runtime
            .invoke(
                "timeline.hyperframes.import".into(),
                to_js(&input).unwrap(),
                JsValue::UNDEFINED,
            )
            .await
            .unwrap_err();
        assert!(message(stale).contains("revision"));
        assert_eq!(from_js(runtime.snapshot().unwrap()), after);

        call(&runtime, "history.undo", json!({})).await;
        assert_eq!(
            from_js(runtime.snapshot().unwrap())["project"],
            before["project"]
        );
        call(&runtime, "history.redo", json!({})).await;
        assert_eq!(
            from_js(runtime.snapshot().unwrap())["project"],
            after["project"]
        );
        let saved = runtime.serialize().unwrap();
        let restored = CanonicalEditorRuntime::new().unwrap();
        restored.restore(&saved).unwrap();
        assert_eq!(
            from_js(restored.snapshot().unwrap()),
            from_js(runtime.snapshot().unwrap())
        );
        let mut corrupted: Value = serde_json::from_slice(&saved).unwrap();
        corrupted["active"]["document"]["project"]["assets"][1]["hyperframes"]["width"] = json!(0);
        assert!(
            restored
                .restore(&serde_json::to_vec(&corrupted).unwrap())
                .is_err()
        );
        assert_eq!(
            from_js(restored.snapshot().unwrap()),
            from_js(runtime.snapshot().unwrap())
        );

        // Object maps, nulls and UTF-8 must cross the real JS boundary intact.
        let snapshot = runtime.snapshot().unwrap();
        let project = js_sys::Reflect::get(&snapshot, &"project".into()).unwrap();
        assert!(project.is_object());
        assert!(!project.is_instance_of::<js_sys::Map>());
        assert!(
            runtime
                .runtime
                .registry()
                .audit_log(100, None)
                .unwrap()
                .iter()
                .all(|a| a.timestamp_ms > 1_700_000_000_000)
        );

        // Restoring an older revision into the same host starts a fresh retry
        // scope; the previous import receipt cannot claim this write exists.
        runtime.restore(&before_bytes).unwrap();
        runtime
            .invoke(
                "timeline.hyperframes.import".into(),
                to_js(&input).unwrap(),
                to_js(&options).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            from_js(runtime.snapshot().unwrap())["project"],
            after["project"]
        );
    }

    #[wasm_bindgen_test]
    async fn browser_discovery_reports_native_requirements_without_running_them() {
        let runtime = CanonicalEditorRuntime::new().unwrap();
        let manifest = from_js(runtime.capabilities().unwrap());
        let capabilities = manifest["capabilities"].as_array().unwrap();
        for id in [
            "hyperframes.project.inspect",
            "timeline.hyperframes.import",
            "media.import",
            "app.state.read",
        ] {
            assert_eq!(
                capabilities.iter().find(|c| c["id"] == id).unwrap()["available"],
                true,
                "{id}"
            );
        }
        for (id, input) in [
            ("media.probe", json!({"path":"C:/must-not-open.mp4"})),
            ("project.open", json!({"path":"C:/must-not-open.opencut"})),
            (
                "job.start",
                json!({"capabilityId":"media.probe","input":{"path":"C:/must-not-open.mp4"}}),
            ),
        ] {
            let descriptor = capabilities.iter().find(|c| c["id"] == id).unwrap();
            assert_eq!(descriptor["available"], false, "{id}");
            assert!(
                descriptor["unavailableReason"]
                    .as_str()
                    .unwrap()
                    .contains("native OpenCut host")
            );
            let error = runtime
                .invoke(id.into(), to_js(&input).unwrap(), JsValue::UNDEFINED)
                .await
                .unwrap_err();
            assert!(message(error).contains("native OpenCut host"));
        }
        assert_eq!(from_js(runtime.snapshot().unwrap())["revision"], 0);
    }

    #[wasm_bindgen_test]
    fn browser_artifacts_use_the_bounded_store_and_real_clock() {
        let runtime = CanonicalEditorRuntime::new().unwrap();
        let artifact = runtime
            .store_artifact(&[1, 2, 3], "image/png", Some(2), Some(3), None)
            .map(from_js)
            .unwrap();
        assert!(artifact["createdAtMs"].as_u64().unwrap() > 1_700_000_000_000);
        assert!(artifact["expiresAtMs"].as_u64() > artifact["createdAtMs"].as_u64());
        assert_eq!(artifact["mimeType"], "image/png");
        assert_eq!(artifact["width"], 2);
        assert_eq!(artifact["height"], 3);
        let uri = artifact["uri"].as_str().unwrap();
        assert_eq!(runtime.read_artifact(uri).unwrap(), vec![1, 2, 3]);
        assert!(runtime.read_artifact("C:/arbitrary/path").is_err());
        assert!(runtime.remove_artifact(uri).unwrap());
        assert!(!runtime.remove_artifact(uri).unwrap());
        assert!(runtime.read_artifact(uri).is_err());
        assert_eq!(from_js(runtime.snapshot().unwrap())["revision"], 0);
    }
}
