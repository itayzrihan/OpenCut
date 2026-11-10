use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const SET: &str = "timeline.classic.selection.set";
async fn call(rt: &OpenCutRuntime, id: &str, input: Value) -> Value { rt.registry().invoke(id, InvocationContext::default(), input).await.unwrap().result.data }
async fn read(rt: &OpenCutRuntime) -> Value { call(rt,"app.state.read",json!({})).await["value"].clone() }
fn input(rt: &OpenCutRuntime, change: Value) -> Value { json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":rt.snapshot().unwrap().revision,"change":change}) }
async fn setup() -> OpenCutRuntime {
    let rt=OpenCutRuntime::default();
    let mut fixture:Value=serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    fixture["mediaAssets"][0]["hasAudio"]=json!(true);
    call(&rt,"project.classic.session.attach",json!({"projectId":"classic-project","expectedRevision":0,"classic":fixture})).await;
    let mut audio=input(&rt,json!({})); audio.as_object_mut().unwrap().remove("change");
    audio["trackId"]=json!("video-track");audio["elementId"]=json!("item-2");audio["action"]=json!("extractLinked");
    call(&rt,"timeline.classic.audio.source.edit",audio).await;
    rt
}
fn tracks(state:&Value)->&Value { &state["project"]["classic"]["document"]["scenes"][0]["tracks"] }

#[tokio::test]
async fn canonical_row_selection_is_scoped_transient_retryable_and_readable() {
    let rt=setup().await; let before=read(&rt).await;
    let archive=call(&rt,"project.classic.session.archive",json!({"projectId":"classic-project"})).await;
    let request=input(&rt,json!({"type":"track","trackId":"video-track"}));
    let mut ctx=InvocationContext { dry_run:true,..Default::default() };ctx.metadata.insert("opencut/idempotencyKey".into(),json!("row-once"));
    rt.registry().invoke(SET,ctx.clone(),request.clone()).await.unwrap();assert_eq!(read(&rt).await,before);
    ctx.dry_run=false;let receipt=rt.registry().invoke(SET,ctx.clone(),request.clone()).await.unwrap();
    assert_eq!(rt.registry().invoke(SET,ctx,request).await.unwrap(),receipt);
    let selected=read(&rt).await;
    assert_eq!(selected["selection"]["itemIds"],json!(["item-2"]));assert_eq!(selected["selection"]["trackIds"],json!(["video-track"]));
    assert_eq!(selected["revision"],before["revision"]);assert_eq!(selected["project"],before["project"]);
    assert_eq!(call(&rt,"project.classic.session.archive",json!({"projectId":"classic-project"})).await,archive);
    let ordinary=call(&rt,SET,input(&rt,json!({"type":"elements","elements":[{"trackId":"video-track","elementId":"item-2"}]}))).await;
    assert!(ordinary["exactTrackId"].is_null());assert_eq!(ordinary["elements"],receipt.result.data["elements"]);
    let row=call(&rt,SET,input(&rt,json!({"type":"track","trackId":"video-track"}))).await;
    assert_eq!(row["changed"],true);assert_eq!(row["exactTrackId"],"video-track");
    let additive=call(&rt,SET,input(&rt,json!({"type":"track","trackId":"titles","additive":true}))).await;
    assert_eq!(additive["elements"].as_array().unwrap().len(),2);assert!(additive["exactTrackId"].is_null());
}

#[tokio::test]
async fn selected_row_edits_leave_linked_other_rows_unchanged_and_undo_restores() {
    for action in ["move","split","trim","delete"] {
        let rt=setup().await;call(&rt,SET,input(&rt,json!({"type":"track","trackId":"video-track"}))).await;
        let before=read(&rt).await;let mut edit=input(&rt,json!({}));edit.as_object_mut().unwrap().remove("change");
        let capability=match action {
            "move"=>{ edit["moves"]=json!([{"sourceTrackId":"video-track","targetTrackId":"video-track","elementId":"item-2","newStartTime":120000}]);"timeline.classic.elements.move" },
            "split"=>{edit["elements"]=json!([{"trackId":"video-track","elementId":"item-2"}]);edit["splitTime"]=json!(600000);"timeline.classic.elements.split"},
            "trim"=>{edit["updates"]=json!([{"trackId":"video-track","elementId":"item-2","patch":{"duration":600000}}]);"timeline.classic.elements.update"},
            _=>{edit["removal"]=json!({"type":"elements","elements":[{"trackId":"video-track","elementId":"item-2"}]});"timeline.classic.remove"}
        };
        call(&rt,capability,edit).await;let after=read(&rt).await;
        assert_eq!(tracks(&after)["audio"],tracks(&before)["audio"],"{action}");assert_eq!(tracks(&after)["overlay"],tracks(&before)["overlay"],"{action}");
        assert_ne!(tracks(&after)["main"],tracks(&before)["main"]);
        if action!="delete" {
            let projection=call(&rt,"timeline.classic.selection.read",json!({"projectId":"classic-project"})).await;
            assert_eq!(projection["exactTrackId"],"video-track");
            assert_eq!(projection["elements"].as_array().unwrap().len(),tracks(&after)["main"]["elements"].as_array().unwrap().len());
            // A host split receipt selecting just its right side must not lose row intent.
            let first=projection["elements"][0].clone();
            call(&rt,SET,input(&rt,json!({"type":"elements","elements":[first],"preserveRowScope":true,"reconcileMissing":true}))).await;
            assert_eq!(call(&rt,"timeline.classic.selection.read",json!({"projectId":"classic-project"})).await["exactTrackId"],"video-track");
        }
        call(&rt,"history.undo",json!({})).await;assert_eq!(read(&rt).await["project"],before["project"]);
        call(&rt,"history.redo",json!({})).await;assert_eq!(read(&rt).await["project"],after["project"]);
    }
}

#[tokio::test]
async fn ordinary_clip_selection_keeps_linked_move_and_invalid_row_requests_are_atomic() {
    let rt=setup().await;let before=read(&rt).await;
    for change in [json!({"type":"track","trackId":"missing"}),json!({"type":"elements","elements":[{"trackId":"titles","elementId":"item-2"}]})] {
        assert!(rt.registry().invoke(SET,InvocationContext::default(),input(&rt,change)).await.is_err());assert_eq!(read(&rt).await,before);
    }
    let mut stale=input(&rt,json!({"type":"track","trackId":"video-track"}));stale["expectedSelectionRevision"]=json!(100);
    assert!(rt.registry().invoke(SET,InvocationContext::default(),stale).await.is_err());
    call(&rt,SET,input(&rt,json!({"type":"elements","elements":[{"trackId":"video-track","elementId":"item-2"}]}))).await;
    let mut movement=input(&rt,json!({}));movement.as_object_mut().unwrap().remove("change");movement["moves"]=json!([{"sourceTrackId":"video-track","targetTrackId":"video-track","elementId":"item-2","newStartTime":120000}]);
    call(&rt,"timeline.classic.elements.move",movement).await;
    assert_eq!(tracks(&read(&rt).await)["audio"][0]["elements"][0]["startTime"],120000);
    call(&rt,"project.classic.scene.open",json!({"projectId":"classic-project","sceneId":"other-scene","expectedRevision":rt.snapshot().unwrap().revision})).await;
    assert_eq!(read(&rt).await["selection"]["itemIds"],json!([]));
    let empty=json!({"projectId":"classic-project","sceneId":"other-scene","expectedRevision":rt.snapshot().unwrap().revision,"change":{"type":"track","trackId":"other-main"}});
    assert!(rt.registry().invoke(SET,InvocationContext::default(),empty).await.is_err());
}

#[tokio::test]
async fn row_intent_survives_two_sequential_edits_and_locked_cancelled_requests_do_not_change_it() {
    let rt=setup().await;
    call(&rt,SET,input(&rt,json!({"type":"track","trackId":"video-track"}))).await;
    let before=read(&rt).await;
    let mut movement=input(&rt,json!({}));movement.as_object_mut().unwrap().remove("change");movement["moves"]=json!([{"sourceTrackId":"video-track","targetTrackId":"video-track","elementId":"item-2","newStartTime":120000}]);
    call(&rt,"timeline.classic.elements.move",movement).await;
    let mut split=input(&rt,json!({}));split.as_object_mut().unwrap().remove("change");split["elements"]=json!([{"trackId":"video-track","elementId":"item-2"}]);split["splitTime"]=json!(600000);
    call(&rt,"timeline.classic.elements.split",split).await;
    let after=read(&rt).await;
    assert_eq!(tracks(&after)["audio"],tracks(&before)["audio"]);
    assert_eq!(tracks(&after)["main"]["elements"].as_array().unwrap().len(),2);
    assert_eq!(after["selection"]["itemIds"].as_array().unwrap().len(),2);
    call(&rt,SET,input(&rt,json!({"type":"elements","elements":[{"trackId":"video-track","elementId":"item-2"}]}))).await;
    let mut ordinary_move=input(&rt,json!({}));ordinary_move.as_object_mut().unwrap().remove("change");ordinary_move["moves"]=json!([{"sourceTrackId":"video-track","targetTrackId":"video-track","elementId":"item-2","newStartTime":240000}]);
    call(&rt,"timeline.classic.elements.move",ordinary_move).await;
    let after=read(&rt).await;
    assert_eq!(tracks(&after)["audio"][0]["elements"][0]["startTime"],120000);
    let context=InvocationContext::default();context.cancellation.cancel();
    assert!(rt.registry().invoke(SET,context,input(&rt,json!({"type":"track","trackId":"titles"}))).await.is_err());
    assert_eq!(read(&rt).await,after);
    call(&rt,"app.state.patch",json!({"expectedRevision":after["revision"],"patch":[{"op":"add","path":"/project/classic/document/scenes/0/tracks/main/locked","value":true}]})).await;
    let locked=read(&rt).await;
    assert!(rt.registry().invoke(SET,InvocationContext::default(),input(&rt,json!({"type":"track","trackId":"video-track"}))).await.is_err());
    assert_eq!(read(&rt).await,locked);
}
