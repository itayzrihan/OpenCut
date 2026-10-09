use opencut_editor_api::{OpenCutRuntime,HostBridge,HostEffectResult,InvocationContext,AccessLevel,register_hyperframes_embedding};
use serde_json::{Value,json};
use std::{future::Future,task::{Context,Waker}};

async fn setup() -> (OpenCutRuntime,HostBridge,Value) {
    let runtime = OpenCutRuntime::full_access().unwrap();
    let host = HostBridge::default();
    register_hyperframes_embedding(&runtime,&host).unwrap();
    let classic: Value = serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    runtime.registry().invoke("project.classic.session.attach",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":0,"classic":classic})).await.unwrap();
    let input = json!({"projectId":"classic-project","expectedRevision":runtime.snapshot().unwrap().revision,"query":"כותרת זכוכית"});
    (runtime,host,input)
}
fn reply(input:&Value) -> HostEffectResult {
    let plan=opencut_editor_api::hyperframes_embedding_plan(input.clone()).unwrap();
    let mut vector=vec![0.0;384]; vector[0]=1.0;
    HostEffectResult::Success{data:json!({"query":plan["query"],"normalizedQuery":plan["normalizedQuery"],"modelRevision":plan["modelRevision"],"vectorRevision":plan["vectorRevision"],"vector":vector})}
}
#[tokio::test]
async fn host_embedding_is_a_scoped_bounded_read_and_rejects_changed_revision_or_result_identity() {
    for scenario in ["ok","wrong-query","wrong-normalization","stale","cancelled"] {
        let (runtime,host,input)=setup().await;
        let before=runtime.snapshot().unwrap();
        let descriptor=runtime.registry().descriptor("hyperframes.examples.embed").unwrap().unwrap();
        assert_eq!(descriptor.access,AccessLevel::Read);
        assert!(descriptor.open_world && descriptor.cancellable && !descriptor.transactional && host.supports(&descriptor));
        let context=InvocationContext::default();
        let cancel=context.cancellation.clone();
        let mut future=std::pin::pin!(runtime.registry().invoke("hyperframes.examples.embed",context,input.clone()));
        assert!(future.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
        let effect=host.pending().unwrap().remove(0);
        assert_eq!(effect.adapter,"hyperframesEmbedding");
        assert_eq!(effect.request,input);
        let mut result=reply(&input);
        if let HostEffectResult::Success{data}= &mut result {
            if scenario=="wrong-query" { data["query"]=json!("another query"); }
            if scenario=="wrong-normalization" { data["normalizedQuery"]=json!("different concepts"); }
        }
        if scenario=="cancelled" { cancel.cancel(); }
        if scenario=="stale" {
            runtime.registry().invoke("app.state.patch",InvocationContext::default(),json!({"expectedRevision":before.revision,"patch":[{"op":"add","path":"/extensions/newFeature","value":true}]})).await.unwrap();
        }
        host.settle(effect.id,result).unwrap();
        let result=future.await;
        assert_eq!(result.is_ok(),scenario=="ok", "{scenario}");
        assert!(host.pending().unwrap().is_empty());
        if scenario!="stale" { assert_eq!(runtime.snapshot().unwrap(),before); }
    }
}
