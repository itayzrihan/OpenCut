use opencut_editor_api::{AccessLevel, HostBridge, HostEffectResult, InvocationContext, OpenCutRuntime, register_generative_host};
use serde_json::{Value, json};
use std::{future::Future, task::{Context, Waker}};

async fn setup() -> (OpenCutRuntime, HostBridge, String) {
    let rt = OpenCutRuntime::full_access().unwrap();
    let host = HostBridge::default();
    register_generative_host(&rt, &host).unwrap();
    let classic: Value = serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let pid = classic["document"]["metadata"]["id"].as_str().unwrap().to_owned();
    call(&rt, "project.classic.session.attach", json!({"projectId":pid,"expectedRevision":0,"classic":classic})).await;
    edit(&rt, &pid, json!({"type":"reference","reference":{"id":"a".repeat(32),"name":"existing.png","mime":"image/png","kind":"image","bytes":17,"storyboard":true}})).await;
    (rt, host, pid)
}
async fn call(rt: &OpenCutRuntime, id: &str, input: Value) -> Value {
    rt.registry().invoke(id, InvocationContext::default(), input).await.unwrap().result.data
}
async fn edit(rt: &OpenCutRuntime, pid: &str, change: Value) {
    call(rt, "project.generative.edit", json!({"projectId":pid,"expectedRevision":rt.snapshot().unwrap().revision,"change":change})).await;
}
fn board() -> Value {
    json!({"title":"מסע חדש","summary":"סרט היכרות ללקוח","sheetReferenceIds":[],"scenes":[{"id":"arrival","title":"ברוכים הבאים","description":"המצלמה מתקרבת לבית, והדלת נפתחת.","startSeconds":0,"endSeconds":4,"imageReferenceId":"a".repeat(32)}]})
}
#[tokio::test]
async fn existing_sheet_and_all_direction_shots_export_without_generation_or_prompt_leakage() {
    let (rt, _, pid) = setup().await;
    edit(&rt,&pid,json!({"type":"direction","text":format!("```json\n{}\n```",json!({"creative_intent":"A welcome story","storyboard_prompt":"PRIVATE IMAGE PROMPT","spoken_script":"PRIVATE SCRIPT","provider_token":"SECRET","shots":[{"start":0,"end":4,"description":"The door opens","camera":"PRIVATE CAMERA PROMPT"},{"start":"4s","end":"8s","description":"Friends enter the room"}]}))})).await;
    let revision = rt.snapshot().unwrap().revision;
    let plan = call(&rt,"project.generative.storyboard.plan",json!({"projectId":pid,"expectedRevision":revision})).await;
    assert_eq!(plan["sheets"].as_array().unwrap().len(),1);
    assert_eq!(plan["scenes"].as_array().unwrap().len(),2);
    assert_eq!(plan["scenes"][1]["startSeconds"],4.0);
    assert!(plan["scenes"][0]["imageReferenceId"].is_null());
    assert_eq!(plan["sceneImages"],json!([]));
    assert!(!plan.to_string().contains("PRIVATE"));
    assert!(!plan.to_string().contains("SECRET"));
    assert_eq!(rt.snapshot().unwrap().revision,revision);
}
#[tokio::test]
async fn structured_client_copy_is_canonical_undoable_and_dry_run_safe() {
    let (rt, _, pid) = setup().await;
    let revision = rt.snapshot().unwrap().revision;
    let input = json!({"projectId":pid,"expectedRevision":revision,"change":{"type":"storyboard","storyboard":board()}});
    rt.registry().invoke("project.generative.edit",InvocationContext{dry_run:true,..Default::default()},input.clone()).await.unwrap();
    assert_eq!(rt.snapshot().unwrap().revision,revision);
    call(&rt,"project.generative.edit",input).await;
    let state = call(&rt,"app.state.read",json!({"pointer":"/project/extensions/generative/storyboard"})).await;
    assert_eq!(state["value"]["title"],"מסע חדש");
    let plan = call(&rt,"project.generative.storyboard.plan",json!({"projectId":pid})).await;
    assert_eq!(plan["sceneImages"].as_array().unwrap().len(),1);
    assert_eq!(plan["scenes"][0]["description"],board()["scenes"][0]["description"]);
    call(&rt,"history.undo",json!({})).await;
    let read = call(&rt,"project.generative.read",json!({"projectId":pid})).await;
    assert!(read["document"].get("storyboard").is_none());
}
#[tokio::test]
async fn rejects_unowned_images_invalid_timing_and_duplicate_scenes_atomically() {
    let (rt, _, pid) = setup().await;
    for variant in 0..4 {
        let mut value = board();
        match variant {
            0 => value["scenes"][0]["imageReferenceId"] = json!("b".repeat(32)),
            1 => value["scenes"][0]["endSeconds"] = json!(-1),
            2 => value["scenes"].as_array_mut().unwrap().push(board()["scenes"][0].clone()),
            _ => value["sheetReferenceIds"] = json!(["https://outside.example/secret.png"]),
        }
        let revision = rt.snapshot().unwrap().revision;
        assert!(rt.registry().invoke("project.generative.edit",InvocationContext::default(),json!({"projectId":pid,"expectedRevision":revision,"change":{"type":"storyboard","storyboard":value}})).await.is_err());
        assert_eq!(rt.snapshot().unwrap().revision,revision);
    }
}
#[tokio::test]
async fn export_is_bounded_open_world_cancellable_and_scoped_without_dry_run_io() {
    let (rt, host, pid) = setup().await;
    let descriptor = rt.registry().descriptor("project.generative.storyboard.export").unwrap().unwrap();
    assert_eq!(descriptor.access,AccessLevel::Write);
    assert!(descriptor.open_world && descriptor.cancellable && !descriptor.transactional && !descriptor.supports_dry_run);
    for (id, revision, dry) in [(pid.clone(),0,false),("other".into(),rt.snapshot().unwrap().revision,false),(pid.clone(),rt.snapshot().unwrap().revision,true)] {
        assert!(rt.registry().invoke("project.generative.storyboard.export",InvocationContext{dry_run:dry,..Default::default()},json!({"projectId":id,"expectedRevision":revision})).await.is_err());
        assert!(host.pending().unwrap().is_empty());
    }
}
#[tokio::test]
async fn host_receipt_must_match_canonical_plan_scope_and_artifact() {
    for mode in ["success", "digest", "revision", "mime", "changed", "cancel"] {
        let (rt, host, pid) = setup().await;
        let revision = rt.snapshot().unwrap().revision;
        let context = InvocationContext::default();
        let cancellation = context.cancellation.clone();
        let mut future = std::pin::pin!(rt.registry().invoke("project.generative.storyboard.export",context,json!({"projectId":pid,"expectedRevision":revision})));
        assert!(future.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
        let effect = host.pending().unwrap().pop().unwrap();
        assert_eq!(effect.adapter,"storyboardPdf");
        assert!(effect.request["plan"]["sheets"][0]["id"].is_string());
        let artifact = rt.artifacts().put(b"%PDF-1.4\nsynthetic host fixture\n%%EOF\n".to_vec(),if mode == "mime" {"image/png"} else {"application/pdf"},None,None,None).unwrap();
        if mode == "changed" { edit(&rt,&pid,json!({"type":"direction","text":"changed while rendering"})).await; }
        if mode == "cancel" { cancellation.cancel(); }
        host.settle(effect.id,HostEffectResult::Success{data:json!({"projectId":pid,"revision":if mode=="revision" {revision+1}else{revision},"planDigest":if mode=="digest" {json!("f".repeat(64))}else{effect.request["plan"]["digest"].clone()},"artifact":artifact,"pageCount":2})}).unwrap();
        let result = future.await;
        if mode == "success" { assert_eq!(result.unwrap().result.artifacts[0],artifact); } else { assert!(result.is_err(),"{mode}"); }
    }
}
