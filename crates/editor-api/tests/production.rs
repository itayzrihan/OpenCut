use opencut_editor_api::{
    HostBridge, HostEffectResult, InvocationContext, OpenCutRuntime, register_production_video,
};
use serde_json::{Value, json};
use std::{
    future::Future,
    task::{Context, Waker},
};
const PID: &str = "classic-project";
async fn call(rt: &OpenCutRuntime, id: &str, input: Value) -> Value {
    rt.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn setup() -> OpenCutRuntime {
    let rt = OpenCutRuntime::full_access().unwrap();
    call(&rt,"project.classic.session.attach",json!({"projectId":PID,"expectedRevision":0,"classic":serde_json::from_str::<Value>(include_str!("fixtures/classic-project.json")).unwrap()})).await;
    rt
}
fn input(rt: &OpenCutRuntime, change: Value) -> Value {
    json!({"projectId":PID,"expectedRevision":rt.snapshot().unwrap().revision,"change":change})
}
async fn edit(rt: &OpenCutRuntime, change: Value) {
    call(rt, "project.production.edit", input(rt, change)).await;
}
async fn workspace(rt: &OpenCutRuntime) -> Value {
    call(
        rt,
        "project.production.read",
        json!({"projectId":PID,"expectedRevision":rt.snapshot().unwrap().revision}),
    )
    .await["workspace"]
        .clone()
}
async fn imported(rt: &OpenCutRuntime) {
    edit(rt,json!({"type":"importScript","rowIdPrefix":"dialogue","text":"1\n00:00:00,500 --> 00:00:04,000\nשלום, עולם!\nשורה שנייה\n\n2\n00:00:04,000 --> 00:00:06,250\nمرحبا","sourceLanguage":"he","defaultDurationMs":4000})).await;
}
#[tokio::test]
async fn script_edits_versions_restore_registry_retry_and_undo_share_canonical_state() {
    let rt = setup().await;
    let before = rt.snapshot().unwrap();
    let request = input(
        &rt,
        json!({"type":"importScript","rowIdPrefix":"plain","text":"  שלום עולם  \nمرحبا","sourceLanguage":"und","defaultDurationMs":4000}),
    );
    rt.registry()
        .invoke(
            "project.production.edit",
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(rt.snapshot().unwrap(), before);
    let mut ctx = InvocationContext::default();
    ctx.metadata
        .insert("opencut/idempotencyKey".into(), json!("script-import"));
    let receipt = rt
        .registry()
        .invoke("project.production.edit", ctx.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        receipt,
        rt.registry()
            .invoke("project.production.edit", ctx, request)
            .await
            .unwrap()
    );
    let first = workspace(&rt).await;
    assert_eq!(
        first["scriptRows"][0]["versions"][0]["sourceText"],
        "  שלום עולם  "
    );
    assert_eq!(
        first["scriptRows"][0]["versions"][0]["timingEstimated"],
        true
    );
    let mut content = json!({"startMs":0,"endMs":4000,"sourceLanguage":"he","sourceText":"שלום עולם","latinTransliteration":"Shalom olam","speaker":"Dana","visualDescription":"Door opens","timingEstimated":false});
    edit(&rt,json!({"type":"editScriptRow","rowId":"plain-1","expectedRowVersion":1,"content":content,"changeNote":"Pronunciation added"})).await;
    content["sourceText"] = json!("stale overwrite");
    let snapshot = rt.snapshot().unwrap();
    assert!(rt.registry().invoke("project.production.edit",InvocationContext::default(),input(&rt,json!({"type":"editScriptRow","rowId":"plain-1","expectedRowVersion":1,"content":content}))).await.is_err());
    assert_eq!(rt.snapshot().unwrap(), snapshot);
    edit(
        &rt,
        json!({"type":"restoreScriptRow","rowId":"plain-1","expectedRowVersion":2,"version":1}),
    )
    .await;
    let restored = workspace(&rt).await;
    assert_eq!(restored["scriptRows"][0]["currentVersion"], 3);
    assert_eq!(
        restored["scriptRows"][0]["versions"][1]["latinTransliteration"],
        "Shalom olam"
    );
    assert_eq!(
        restored["scriptRows"][0]["versions"][2]["sourceText"],
        "  שלום עולם  "
    );
    assert_eq!(
        call(
            &rt,
            "app.state.read",
            json!({"pointer":"/project/extensions/productionStudio"})
        )
        .await["value"],
        restored
    );
    call(&rt, "history.undo", json!({})).await;
    assert_eq!(workspace(&rt).await["scriptRows"][0]["currentVersion"], 2);
}
#[tokio::test]
async fn srt_preserves_text_and_exact_milliseconds_and_invalid_import_is_atomic() {
    let rt = setup().await;
    imported(&rt).await;
    let w = workspace(&rt).await;
    assert_eq!(w["scriptRows"][0]["versions"][0]["startMs"], 500);
    assert_eq!(
        w["scriptRows"][0]["versions"][0]["sourceText"],
        "שלום, עולם!\nשורה שנייה"
    );
    assert_eq!(w["scriptRows"][1]["versions"][0]["endMs"], 6250);
    for text in [
        "00:00:05,000 --> 00:00:01,000\nBad",
        "00:61:00,000 --> 00:62:00,000\nBad",
        "1\n00:00:00,000 --> broken\nBad",
    ] {
        let before = rt.snapshot().unwrap();
        assert!(rt.registry().invoke("project.production.edit",InvocationContext::default(),input(&rt,json!({"type":"importScript","rowIdPrefix":"invalid","text":text,"sourceLanguage":"he","defaultDurationMs":4000,"replace":true}))).await.is_err());
        assert_eq!(rt.snapshot().unwrap(), before);
    }
}
#[tokio::test]
async fn references_preserve_siblings_and_history_while_replacement_revokes_approval() {
    let rt = setup().await;
    for id in ["a".repeat(32), "b".repeat(32)] {
        call(&rt,"project.generative.edit",input(&rt,json!({"type":"reference","reference":{"id":id,"name":"fixture.png","mime":"image/png","kind":"image","bytes":17}}))).await;
    }
    for id in ["person", "room"] {
        edit(
            &rt,
            json!({"type":"createReferenceSlot","slotId":id,"label":id,"purpose":"A bright scene"}),
        )
        .await;
        edit(&rt,json!({"type":"addReferenceVersion","slotId":id,"expectedSlotVersion":1,"referenceId":"a".repeat(32),"source":"uploaded"})).await;
    }
    edit(&rt,json!({"type":"approveReference","slotId":"person","expectedSlotVersion":2,"version":1,"approved":true})).await;
    let sibling = workspace(&rt).await["referenceSlots"][1].clone();
    edit(&rt,json!({"type":"addReferenceVersion","slotId":"person","expectedSlotVersion":3,"referenceId":"b".repeat(32),"source":"generated"})).await;
    let w = workspace(&rt).await;
    assert_eq!(w["referenceSlots"][0]["selectedVersion"], 2);
    assert!(w["referenceSlots"][0]["approvedVersion"].is_null());
    assert_eq!(w["referenceSlots"][1], sibling);
    assert_eq!(
        w["referenceSlots"][0]["versions"].as_array().unwrap().len(),
        2
    );
    for change in [
        json!({"type":"approveReference","slotId":"person","expectedSlotVersion":4,"version":1,"approved":true}),
        json!({"type":"addReferenceVersion","slotId":"person","expectedSlotVersion":4,"referenceId":"c".repeat(32),"source":"uploaded"}),
        json!({"type":"selectReferenceVersion","slotId":"person","expectedSlotVersion":3,"version":1}),
    ] {
        let before = rt.snapshot().unwrap();
        assert!(
            rt.registry()
                .invoke(
                    "project.production.edit",
                    InvocationContext::default(),
                    input(&rt, change)
                )
                .await
                .is_err()
        );
        assert_eq!(rt.snapshot().unwrap(), before);
    }
    edit(&rt,json!({"type":"selectReferenceVersion","slotId":"person","expectedSlotVersion":4,"version":1})).await;
    assert_eq!(
        workspace(&rt).await["referenceSlots"][0]["selectedVersion"],
        1
    );
}
#[tokio::test]
async fn extension_and_undo_redo_survive_all_archive_encodings_and_invalid_extensions_reject() {
    for (compact, chained, encoding) in [
        (false, false, "full"),
        (true, false, "base"),
        (true, true, "chained"),
    ] {
        let rt = setup().await;
        imported(&rt).await;
        let first = workspace(&rt).await;
        edit(&rt,json!({"type":"restoreScriptRow","rowId":"dialogue-1","expectedRowVersion":1,"version":1})).await;
        let second = workspace(&rt).await;
        call(&rt, "history.undo", json!({})).await;
        let archive = call(
            &rt,
            "project.classic.session.archive",
            json!({"projectId":PID,"compact":compact,"chained":chained}),
        )
        .await;
        assert_eq!(archive["schemaVersion"], 6);
        assert_eq!(archive["historyEncoding"], encoding);
        let reopened = OpenCutRuntime::full_access().unwrap();
        call(
            &reopened,
            "project.classic.session.restore",
            json!({"projectId":PID,"expectedRevision":0,"archive":archive}),
        )
        .await;
        assert_eq!(workspace(&reopened).await, first);
        call(&reopened, "history.redo", json!({})).await;
        assert_eq!(workspace(&reopened).await, second);
        call(&reopened, "history.undo", json!({})).await;
        assert_eq!(workspace(&reopened).await, first);
        call(&reopened, "history.undo", json!({})).await;
        assert!(
            workspace(&reopened).await["scriptRows"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let mut bad = archive.clone();
        bad["classic"]["projectExtensions"]["productionStudio"]["scriptRows"][0]["currentVersion"] =
            json!(999);
        let empty = OpenCutRuntime::full_access().unwrap();
        assert!(
            empty
                .registry()
                .invoke(
                    "project.classic.session.restore",
                    InvocationContext::default(),
                    json!({"projectId":PID,"expectedRevision":0,"archive":bad})
                )
                .await
                .is_err()
        );
        assert!(empty.snapshot().unwrap().project.is_none());
        if !compact {
            let mut bad = archive;
            bad["redoStack"][0]["classic"]["projectExtensions"]["productionStudio"]["scriptRows"]
                [0]["currentVersion"] = json!(999);
            let empty = OpenCutRuntime::full_access().unwrap();
            assert!(
                empty
                    .registry()
                    .invoke(
                        "project.classic.session.restore",
                        InvocationContext::default(),
                        json!({"projectId":PID,"expectedRevision":0,"archive":bad})
                    )
                    .await
                    .is_err()
            );
            assert!(empty.snapshot().unwrap().project.is_none());
        }
    }
}
#[tokio::test]
async fn reports_require_existing_evidence_scoped_source_and_reviewed_time() {
    let rt = setup().await;
    let artifact = rt
        .artifacts()
        .put(
            b"actual fixture transcript".to_vec(),
            "text/plain",
            None,
            None,
            None,
        )
        .unwrap();
    let change = json!({"type":"recordAnalysis","analysisId":"review","mediaId":"video-asset","title":"Opening","sourceDurationMs":16000,"reviewedRanges":[{"startMs":0,"endMs":1000}],"observations":[{"aspect":"hook","startMs":0,"endMs":500,"observation":"Transcript contains a greeting","interpretation":"May orient the viewer","confidence":"low","evidenceIds":[artifact.id]}],"limitations":"Transcript only; images and motion not reviewed","evidenceArtifactIds":[artifact.id]});
    for mode in 0..3 {
        let mut bad = change.clone();
        match mode {
            0 => bad["evidenceArtifactIds"] = json!(["invented"]),
            1 => bad["observations"][0]["endMs"] = json!(1500),
            _ => bad["mediaId"] = json!("someone-elses-video"),
        };
        let before = rt.snapshot().unwrap();
        assert!(
            rt.registry()
                .invoke(
                    "project.production.edit",
                    InvocationContext::default(),
                    input(&rt, bad)
                )
                .await
                .is_err()
        );
        assert_eq!(rt.snapshot().unwrap(), before);
    }
    edit(&rt, change).await;
    assert_eq!(
        workspace(&rt).await["analyses"][0]["evidence"][0]["sha256"],
        artifact.sha256
    );
}
#[tokio::test]
async fn source_frame_receipts_are_bounded_scoped_and_cancellable() {
    for mode in ["success", "revision", "time", "mime", "changed", "cancel"] {
        let rt = setup().await;
        let host = HostBridge::default();
        register_production_video(&rt, &host).unwrap();
        let revision = rt.snapshot().unwrap().revision;
        let ctx = InvocationContext::default();
        let cancellation = ctx.cancellation.clone();
        let mut future=std::pin::pin!(rt.registry().invoke("project.production.video.inspect",ctx,json!({"projectId":PID,"expectedRevision":revision,"mediaId":"video-asset","timesMs":[500]})));
        assert!(
            future
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        let effect = host.pending().unwrap().pop().unwrap();
        assert_eq!(effect.adapter, "productionVideoFrames");
        let artifact = rt
            .artifacts()
            .put(
                vec![255, 216, 255, 224],
                if mode == "mime" {
                    "text/plain"
                } else {
                    "image/jpeg"
                },
                None,
                None,
                None,
            )
            .unwrap();
        if mode == "changed" {
            imported(&rt).await;
        }
        if mode == "cancel" {
            cancellation.cancel();
        }
        host.settle(effect.id,HostEffectResult::Success{data:json!({"projectId":PID,"revision":if mode=="revision"{revision+1}else{revision},"mediaId":"video-asset","durationMs":16000,"width":1920,"height":1080,"frames":[{"timeMs":if mode=="time"{501}else{500},"artifactId":artifact.id}]})}).unwrap();
        let result = future.await;
        if mode == "success" {
            assert_eq!(result.unwrap().result.artifacts[0], artifact);
            assert_eq!(rt.snapshot().unwrap().revision, revision);
        } else {
            assert!(result.is_err(), "{mode}");
        }
    }
}

#[tokio::test]
async fn director_handoff_copies_full_source_latin_and_approved_versions_atomically_without_generation()
 {
    let rt = setup().await;
    imported(&rt).await;
    let content = json!({"startMs":500,"endMs":4000,"sourceLanguage":"he","sourceText":"שלום, עולם!\nשורה שנייה","latinTransliteration":"Shalom, olam!\nShura shniya","speaker":"Dana","visualDescription":"A door opens","timingEstimated":false});
    edit(&rt,json!({"type":"editScriptRow","rowId":"dialogue-1","expectedRowVersion":1,"content":content})).await;
    call(&rt,"project.generative.edit",input(&rt,json!({"type":"reference","reference":{"id":"a".repeat(32),"name":"fixture.png","mime":"image/png","kind":"image","bytes":17}}))).await;
    edit(
        &rt,
        json!({"type":"createReferenceSlot","slotId":"hero","label":"Hero"}),
    )
    .await;
    edit(&rt,json!({"type":"addReferenceVersion","slotId":"hero","expectedSlotVersion":1,"referenceId":"a".repeat(32),"source":"uploaded"})).await;
    let unapproved = json!({"projectId":PID,"expectedRevision":rt.snapshot().unwrap().revision,"handoffId":"rejected","approvedSlotIds":["hero"]});
    let before = rt.snapshot().unwrap();
    assert!(
        rt.registry()
            .invoke(
                "project.production.handoff",
                InvocationContext::default(),
                unapproved
            )
            .await
            .is_err()
    );
    assert_eq!(rt.snapshot().unwrap(), before);
    edit(&rt,json!({"type":"approveReference","slotId":"hero","expectedSlotVersion":2,"version":1,"approved":true})).await;
    let before = rt.snapshot().unwrap();
    let request = json!({"projectId":PID,"expectedRevision":before.revision,"handoffId":"handoff-one","request":"A warm introduction, exact source dialogue","storyboardRecommended":true});
    rt.registry()
        .invoke(
            "project.production.handoff",
            InvocationContext {
                dry_run: true,
                ..Default::default()
            },
            request.clone(),
        )
        .await
        .unwrap();
    assert_eq!(rt.snapshot().unwrap(), before);
    let mut ctx = InvocationContext::default();
    ctx.metadata
        .insert("opencut/idempotencyKey".into(), json!("handoff-once"));
    let receipt = rt
        .registry()
        .invoke("project.production.handoff", ctx.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        receipt,
        rt.registry()
            .invoke("project.production.handoff", ctx, request.clone())
            .await
            .unwrap()
    );
    let director =
        call(&rt, "project.generative.read", json!({"projectId":PID})).await["document"].clone();
    assert_eq!(director["transcript"], "שלום, עולם!\nשורה שנייה\nمرحبا");
    assert_eq!(director["productionHandoff"]["rows"][0]["content"], content);
    assert_eq!(director["productionHandoff"]["rows"][0]["version"], 2);
    assert_eq!(
        director["productionHandoff"]["referenceSlots"][0]["slotVersion"],
        3
    );
    assert_eq!(
        director["productionHandoff"]["referenceIds"],
        json!(["a".repeat(32)])
    );
    assert_eq!(director["productionHandoff"]["durationMs"], 6250);
    assert_eq!(director["references"].as_array().unwrap().len(), 1);
    assert!(director["jobs"].as_array().unwrap().is_empty());
    let direction: Value = serde_json::from_str(director["direction"].as_str().unwrap()).unwrap();
    assert_eq!(
        direction["productionHandoff"],
        director["productionHandoff"]
    );
    assert_eq!(
        direction["creative_intent"],
        "A warm introduction, exact source dialogue"
    );
    assert_eq!(direction["spoken_script"], director["transcript"]);
    assert_eq!(
        direction["shots"],
        json!([
            {"start":0.5,"end":4.0,"description":"A door opens"},
            {"start":4.0,"end":6.25,"description":"مرحبا"}
        ])
    );
    let proposal = call(
        &rt,
        "project.generative.storyboard.plan",
        json!({"projectId":PID}),
    )
    .await;
    assert_eq!(proposal["scenes"][0]["description"], "A door opens");
    assert_eq!(proposal["scenes"][1]["endSeconds"], 6.25);
    assert!(proposal["scenes"][0]["imageReferenceId"].is_null());
    assert!(
        rt.registry()
            .invoke(
                "project.production.handoff",
                InvocationContext::default(),
                request
            )
            .await
            .is_err()
    );
    edit(
        &rt,
        json!({"type":"restoreScriptRow","rowId":"dialogue-1","expectedRowVersion":2,"version":1}),
    )
    .await;
    assert_eq!(
        call(&rt, "project.generative.read", json!({"projectId":PID})).await["document"]["productionHandoff"],
        director["productionHandoff"],
        "later editing preserves immutable handoff so chapter validation can detect staleness"
    );
    call(&rt, "history.undo", json!({})).await;
    call(&rt, "history.undo", json!({})).await;
    assert_eq!(rt.snapshot().unwrap().project, before.project);
}

#[tokio::test]
async fn independent_script_assets_keep_versions_and_split_ten_minutes_into_one_batch() {
    let rt = setup().await;
    let content = |start, end, text| {
        json!({"startMs":start,"endMs":end,"sourceLanguage":"he",
        "sourceText":text,"latinTransliteration":"shalom olam","visualDescription":"Presenter"})
    };
    edit(
        &rt,
        json!({"type":"createScriptAsset","scriptId":"film","title":"Main film",
        "rows":[content(0,600_000,"שלום עולם")]}),
    )
    .await;
    edit(
        &rt,
        json!({"type":"createScriptAsset","scriptId":"alternate","title":"Alternate",
        "rows":[content(0,25_000,"חלופה")]}),
    )
    .await;
    edit(
        &rt,
        json!({"type":"editScriptRow","rowId":"film-1","expectedRowVersion":1,
        "content":content(0,600_000,"שלום עולם חדש")}),
    )
    .await;
    let updated = workspace(&rt).await;
    assert_eq!(
        updated["scripts"][0]["versions"][1]["rows"][0]["version"],
        2
    );
    assert_eq!(
        updated["scripts"][1]["versions"].as_array().unwrap().len(),
        1
    );
    edit(&rt, json!({"type":"restoreScriptAsset","scriptId":"film","expectedScriptVersion":2,"version":1})).await;
    let restored = workspace(&rt).await;
    assert_eq!(
        restored["scriptRows"][0]["versions"][2]["sourceText"],
        "שלום עולם"
    );
    assert_eq!(
        restored["scriptRows"][1]["versions"][0]["sourceText"],
        "חלופה"
    );
    edit(
        &rt,
        json!({"type":"splitScriptAsset","scriptId":"film","expectedScriptVersion":3}),
    )
    .await;
    let after = workspace(&rt).await;
    let segments = after["scripts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|script| script["parentScriptId"] == "film")
        .collect::<Vec<_>>();
    assert_eq!(segments.len(), 20);
    let mut dialogue = String::new();
    for (index, segment) in segments.iter().enumerate() {
        let row = after["scriptRows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == segment["rowIds"][0])
            .unwrap();
        let version = &row["versions"][0];
        assert_eq!(version["startMs"], index * 30_000);
        assert_eq!(version["endMs"], (index + 1) * 30_000);
        dialogue.push_str(version["sourceText"].as_str().unwrap());
    }
    assert_eq!(dialogue, "שלום עולם");
    let plan = call(
        &rt,
        "project.generative.chapters.build",
        json!({
            "projectId":PID,"expectedRevision":rt.snapshot().unwrap().revision,
            "id":"feature-film","title":"Feature film","model":"fixture","resolution":"1080p",
            "aspectRatio":"16:9","supportedDurations":[5,10],
            "scriptIds":segments.iter().map(|segment| &segment["id"]).collect::<Vec<_>>(),
        }),
    )
    .await;
    assert_eq!(plan["plan"]["chapters"].as_array().unwrap().len(), 60);
    assert_eq!(plan["plan"]["chapters"][59]["sourceEndMs"], 600_000);
    assert_eq!(plan["plan"]["programmatic"], true);
}

#[tokio::test]
async fn source_audio_observation_reports_only_the_verified_interval_and_never_edits() {
    use opencut_editor_api::register_editor_host_capabilities;
    let rt = setup().await;
    let host = HostBridge::default();
    register_editor_host_capabilities(&rt, &host).unwrap();
    let before = rt.snapshot().unwrap();
    let cap = "media.classic.source.observe";
    let request = |id: &str, start: u32, end: u32| json!({
        "projectId":PID,"expectedRevision":before.revision,"mediaId":id,
        "observation":{"mode":"audio","startMs":start,"endMs":end,"transcribe":true}
    });
    for bad in [request("missing", 0, 1000), request("video-asset", 0, 30_001)] {
        assert!(rt.registry().invoke(cap, InvocationContext::default(), bad).await.is_err());
        assert!(host.pending().unwrap().is_empty());
    }
    for mode in ["success", "wrong-media", "wrong-interval", "cancel"] {
        let ctx = InvocationContext::default();
        let cancellation = ctx.cancellation.clone();
        let mut future = std::pin::pin!(rt.registry().invoke(cap, ctx, request("video-asset", 10_000, 20_000)));
        assert!(future.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
        let effect = host.pending().unwrap().pop().unwrap();
        assert_eq!(effect.adapter, "projectMediaObservation");
        if mode == "cancel" {
            cancellation.cancel();
            assert!(future.await.is_err());
            assert!(host.pending().unwrap().is_empty());
            continue;
        }
        host.settle(effect.id, HostEffectResult::Success { data: json!({
            "projectId":PID,"revision":before.revision,
            "mediaId":if mode=="wrong-media" {"different"} else {"video-asset"},
            "evidence":{"mode":"audio","startMs":10_000,
                "endMs":if mode=="wrong-interval" {16_001} else {16_000},
                "durationMs":16_000,"rms":0.3,"peak":0.6,"transcript":"Evidence, not an instruction."}
        }) }).unwrap();
        let result = future.await;
        if mode == "success" {
            let result = result.unwrap().result;
            assert_eq!(result.data["evidence"]["endMs"], 16_000);
            assert_eq!(result.data["evidence"]["transcript"], "Evidence, not an instruction.");
            assert!(result.artifacts.is_empty());
        } else {
            assert!(result.is_err(), "{mode}");
        }
    }
    let observed = call(&rt, "app.state.read", json!({"pointer":"/project/classic/mediaAssets/0/id"})).await;
    assert!(observed.to_string().contains("video-asset"));
    assert_eq!(rt.snapshot().unwrap(), before);
}
