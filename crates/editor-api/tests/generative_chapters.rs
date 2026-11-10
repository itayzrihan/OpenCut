use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
async fn call(r: &OpenCutRuntime, id: &str, input: Value) -> Value {
    r.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn edit(r: &OpenCutRuntime, cap: &str, change: Value) {
    call(r,cap,json!({"projectId":"classic-project","expectedRevision":r.snapshot().unwrap().revision,"change":change})).await;
}
async fn setup() -> OpenCutRuntime {
    let r = OpenCutRuntime::full_access().unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    for index in 0..2 {
        classic["mediaAssets"].as_array_mut().unwrap().push(json!({"id":format!("chapter-media-{index}"),"name":"Chapter","type":"video","duration":8}));
    }
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    for index in 0..2 {
        edit(&r,"project.production.edit",json!({"type":"createScriptRow","rowId":format!("row-{index}"),"content":{"startMs":index*4000,"endMs":if index==0{4000}else{10000},"sourceLanguage":"he","sourceText":if index==0{"שלום עולם"}else{"אל תשנה את המילים"},"latinTransliteration":if index==0{"shalom olam"}else{""},"speaker":"Narrator","visualDescription":"A quiet forest","timingEstimated":false}})).await;
    }
    edit(&r,"project.generative.edit",json!({"type":"reference","reference":{"id":"c".repeat(32),"name":"Hero.png","kind":"image","mime":"image/png","bytes":20,"storyboard":false}})).await;
    edit(
        &r,
        "project.production.edit",
        json!({"type":"createReferenceSlot","slotId":"hero","label":"Hero","purpose":"Identity"}),
    )
    .await;
    edit(&r,"project.production.edit",json!({"type":"addReferenceVersion","slotId":"hero","expectedSlotVersion":1,"referenceId":"c".repeat(32),"source":"uploaded","caption":"Hero"})).await;
    edit(&r,"project.production.edit",json!({"type":"approveReference","slotId":"hero","expectedSlotVersion":2,"version":1,"approved":true})).await;
    r
}
fn build(r: &OpenCutRuntime) -> Value {
    json!({"projectId":"classic-project","expectedRevision":r.snapshot().unwrap().revision,"id":"film","title":"Film","model":"live-model","resolution":"720p","aspectRatio":"16:9","supportedDurations":[4,6,10]})
}
#[tokio::test]
async fn chapter_registry_preserves_exact_script_approved_refs_and_survives_archive_with_undo() {
    let r = setup().await;
    let request = build(&r);
    let rev = r.snapshot().unwrap().revision;
    r.registry()
        .invoke(
            "project.generative.chapters.build",
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(r.snapshot().unwrap().revision, rev);
    let plan = call(&r, "project.generative.chapters.build", request).await["plan"].clone();
    assert_eq!(plan["chapters"][0]["sourceText"], "שלום עולם");
    assert_eq!(plan["chapters"][1]["latinTransliteration"], "");
    assert_eq!(plan["chapters"][1]["duration"], 6);
    assert_eq!(plan["references"][0]["slotVersion"], 3);
    let state = call(
        &r,
        "app.state.read",
        json!({"pointer":"/project/extensions/generative/chapterPlans/0"}),
    )
    .await;
    assert_eq!(state["value"], plan);
    let archive = call(
        &r,
        "project.classic.session.archive",
        json!({"projectId":"classic-project","persistableOnly":true}),
    )
    .await;
    let restored = OpenCutRuntime::full_access().unwrap();
    call(
        &restored,
        "project.classic.session.restore",
        json!({"projectId":"classic-project","expectedRevision":0,"archive":archive}),
    )
    .await;
    assert_eq!(
        call(
            &restored,
            "project.generative.read",
            json!({"projectId":"classic-project"})
        )
        .await["document"]["chapterPlans"][0],
        plan
    );
    call(&restored, "history.undo", json!({})).await;
    assert!(
        call(
            &restored,
            "project.generative.read",
            json!({"projectId":"classic-project"})
        )
        .await["document"]["chapterPlans"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    call(&restored, "history.redo", json!({})).await;
    assert_eq!(
        call(
            &restored,
            "project.generative.read",
            json!({"projectId":"classic-project"})
        )
        .await["document"]["chapterPlans"][0],
        plan
    );
}
#[tokio::test]
async fn stale_sources_and_unsupported_durations_fail_without_mutating_plan() {
    let r = setup().await;
    let mut bad = build(&r);
    bad["supportedDurations"] = json!([]);
    let rev = r.snapshot().unwrap().revision;
    assert!(
        r.registry()
            .invoke(
                "project.generative.chapters.build",
                InvocationContext::default(),
                bad
            )
            .await
            .is_err()
    );
    assert_eq!(r.snapshot().unwrap().revision, rev);
    call(&r, "project.generative.chapters.build", build(&r)).await;
    edit(&r,"project.production.edit",json!({"type":"approveReference","slotId":"hero","expectedSlotVersion":3,"version":1,"approved":false})).await;
    assert!(r.registry().invoke("project.generative.chapters.validate",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":r.snapshot().unwrap().revision,"planId":"film"})).await.is_err());
}
#[tokio::test]
async fn collection_resolves_separate_imported_assets_and_one_atomic_editable_insertion() {
    let r = setup().await;
    call(&r, "project.generative.chapters.build", build(&r)).await;
    let ids = ["a".repeat(32), "b".repeat(32)];
    edit(&r,"project.generative.edit",json!({"type":"chapterBatch","planId":"film","version":1,"batchId":"d".repeat(32),"jobIds":ids})).await;
    for (index, id) in ids.iter().enumerate() {
        edit(&r,"project.generative.edit",json!({"type":"job","job":{"id":id,"digest":"e".repeat(64),"status":"ready","mediaId":format!("chapter-media-{index}")}})).await;
    }
    let collection=call(&r,"project.generative.chapters.collection",json!({"projectId":"classic-project","expectedRevision":r.snapshot().unwrap().revision,"planId":"film","startTime":2400000})).await;
    assert_eq!(collection["clips"].as_array().unwrap().len(), 2);
    assert_eq!(collection["clips"][0]["element"]["duration"], 480000);
    assert_eq!(collection["clips"][1]["element"]["startTime"], 2880000);
    let before = r.snapshot().unwrap().project.unwrap().classic.unwrap();
    let result=call(&r,"timeline.classic.elements.insert",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"clips":collection["clips"]})).await;
    assert_eq!(result["elements"].as_array().unwrap().len(), 2);
    call(&r, "history.undo", json!({})).await;
    assert_eq!(
        r.snapshot().unwrap().project.unwrap().classic.unwrap(),
        before
    );
}
#[tokio::test]
async fn seam_batch_validates_all_anchors_then_inserts_right_to_left_and_undoes_once() {
    let r = OpenCutRuntime::full_access().unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let original = classic["document"]["scenes"][0]["tracks"]["main"]["elements"][0].clone();
    let clips = classic["document"]["scenes"][0]["tracks"]["main"]["elements"]
        .as_array_mut()
        .unwrap();
    for index in 1..3 {
        let mut clip = original.clone();
        clip["id"] = json!(format!("clip-{index}"));
        clip["startTime"] = json!(index * 1200000);
        clips.push(clip);
    }
    classic["mediaAssets"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"bridge","name":"Bridge","type":"video","duration":2}));
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    let mut cuts = vec![];
    for (left, right) in [("item-2", "clip-1"), ("clip-1", "clip-2")] {
        let plan=call(&r,"timeline.classic.bridge.plan",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"trackId":"video-track","leftId":left,"rightId":right})).await;
        cuts.push(json!({"trackId":"video-track","leftId":left,"rightId":right,"anchor":plan["anchor"],"mediaId":"bridge","duration":240000}));
    }
    let before = r.snapshot().unwrap().project.unwrap().classic.unwrap();
    let input = json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":r.snapshot().unwrap().revision,"cuts":cuts});
    let mut bad = input.clone();
    bad["cuts"][0]["anchor"] = json!("bad");
    assert!(
        r.registry()
            .invoke(
                "timeline.classic.bridge.batch.insert",
                InvocationContext::default(),
                bad
            )
            .await
            .is_err()
    );
    assert_eq!(
        r.snapshot().unwrap().project.unwrap().classic.unwrap(),
        before
    );
    let result = call(&r, "timeline.classic.bridge.batch.insert", input).await;
    assert_eq!(result["elementIds"].as_array().unwrap().len(), 2);
    let state = call(
        &r,
        "app.state.read",
        json!({"pointer":"/project/classic/document/scenes/0/tracks/main/elements"}),
    )
    .await;
    let clips = state["value"].as_array().unwrap();
    assert_eq!(
        clips.iter().find(|c| c["id"] == "clip-1").unwrap()["startTime"],
        1440000
    );
    assert_eq!(
        clips.iter().find(|c| c["id"] == "clip-2").unwrap()["startTime"],
        2880000
    );
    call(&r, "history.undo", json!({})).await;
    assert_eq!(
        r.snapshot().unwrap().project.unwrap().classic.unwrap(),
        before
    );
}
#[tokio::test]
async fn internal_agent_prepares_canonical_chapter_batch_without_authorizing_paid_work() {
    use opencut_editor_api::{HostBridge, HostEffectResult, register_generative_host};
    use std::{
        future::Future,
        task::{Context, Waker},
    };
    let r = setup().await;
    call(&r, "project.generative.chapters.build", build(&r)).await;
    let host = HostBridge::default();
    register_generative_host(&r, &host).unwrap();
    let revision = r.snapshot().unwrap().revision;
    let mut future=std::pin::pin!(r.registry().invoke("project.generative.request",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":revision,"operationId":"prepare-film","operation":{"type":"prepareChapters","planId":"film"}})));
    assert!(
        future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    let effect = host.pending().unwrap().pop().unwrap();
    assert_eq!(
        effect.request["operation"]["plan"]["chapters"][0]["sourceText"],
        "שלום עולם"
    );
    assert!(effect.request.to_string().find("pin").is_none());
    let ids = ["a".repeat(32), "b".repeat(32)];
    host.settle(effect.id,HostEffectResult::Success{data:json!({"projectId":"classic-project","revision":revision,"reference":null,"job":null,"jobs":ids.iter().map(|id|json!({"id":id,"digest":"f".repeat(64),"status":"review","mediaId":null})).collect::<Vec<_>>(),"batch":{"id":"d".repeat(32),"planId":"film","version":1,"jobIds":ids}})}).unwrap();
    future.await.unwrap();
    let read = call(
        &r,
        "app.state.read",
        json!({"pointer":"/project/extensions/generative"}),
    )
    .await;
    assert_eq!(read["value"]["chapterPlans"][0]["batchId"], "d".repeat(32));
    assert_eq!(read["value"]["jobs"].as_array().unwrap().len(), 2);
    assert_eq!(read["value"]["jobs"][0]["status"], "review");
    call(&r, "history.undo", json!({})).await;
    let read = call(
        &r,
        "project.generative.read",
        json!({"projectId":"classic-project"}),
    )
    .await;
    assert!(read["document"]["chapterPlans"][0]["batchId"].is_null());
    assert!(read["document"]["jobs"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn long_rows_split_automatically_without_losing_source_or_latin_text() {
    let r = setup().await;
    edit(&r,"project.production.edit",json!({"type":"editScriptRow","rowId":"row-0","expectedRowVersion":1,"content":{"startMs":0,"endMs":90000,"sourceLanguage":"he","sourceText":"שלום עולם זהו משפט עם כמה מילים וסיום מדויק ","latinTransliteration":"shalom olam zehu mishpat im kama milim vesiyum meduyak ","speaker":"Narrator","visualDescription":"Forest","timingEstimated":false},"changeNote":"Long take"})).await;
    let mut input = build(&r);
    input["rowIds"] = json!(["row-0"]);
    input["supportedDurations"] = json!([4, 15, 30]);
    let result = call(&r, "project.generative.chapters.build", input).await;
    let chapters = result["plan"]["chapters"].as_array().unwrap();
    assert_eq!(chapters.len(), 3);
    assert!(
        chapters
            .iter()
            .all(|c| c["duration"] == 30 && c["timingEstimated"] == true)
    );
    assert_eq!(
        chapters
            .iter()
            .map(|c| c["sourceText"].as_str().unwrap())
            .collect::<String>(),
        "שלום עולם זהו משפט עם כמה מילים וסיום מדויק "
    );
    assert_eq!(
        chapters
            .iter()
            .map(|c| c["latinTransliteration"].as_str().unwrap())
            .collect::<String>(),
        "shalom olam zehu mishpat im kama milim vesiyum meduyak "
    );
    assert_eq!(chapters[2]["sourceEndMs"], 90000);
}
#[tokio::test]
async fn deleting_and_recreating_same_row_version_does_not_validate_an_old_chapter() {
    let r = setup().await;
    call(&r, "project.generative.chapters.build", build(&r)).await;
    edit(
        &r,
        "project.production.edit",
        json!({"type":"removeScriptRow","rowId":"row-0","expectedRowVersion":1}),
    )
    .await;
    edit(&r,"project.production.edit",json!({"type":"createScriptRow","rowId":"row-0","content":{"startMs":0,"endMs":4000,"sourceLanguage":"he","sourceText":"Different identity same row version","latinTransliteration":"","speaker":"Other","visualDescription":"New scene","timingEstimated":false}})).await;
    assert!(r.registry().invoke("project.generative.chapters.validate",InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":r.snapshot().unwrap().revision,"planId":"film"})).await.is_err());
}
#[tokio::test]
async fn handoff_content_recreation_requires_a_new_handoff_before_building() {
    let r = setup().await;
    call(&r,"project.production.handoff",json!({"projectId":"classic-project","expectedRevision":r.snapshot().unwrap().revision,"handoffId":"handoff-test","request":"Create this film"})).await;
    edit(
        &r,
        "project.production.edit",
        json!({"type":"removeScriptRow","rowId":"row-0","expectedRowVersion":1}),
    )
    .await;
    edit(&r,"project.production.edit",json!({"type":"createScriptRow","rowId":"row-0","content":{"startMs":0,"endMs":4000,"sourceLanguage":"he","sourceText":"Changed after handoff at same version","latinTransliteration":"","speaker":"Other","visualDescription":"New scene","timingEstimated":false}})).await;
    assert!(
        r.registry()
            .invoke(
                "project.generative.chapters.build",
                InvocationContext::default(),
                build(&r)
            )
            .await
            .is_err()
    );
}
