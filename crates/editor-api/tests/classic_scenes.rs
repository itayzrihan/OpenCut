use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

const SCENES: &str = "project.classic.scenes.edit";
const DELETE: &str = "project.classic.scene.delete";
const BOOKMARKS: &str = "timeline.classic.bookmarks.edit";

#[tokio::test]
async fn viewer_navigation_is_compact_fenced_and_leaves_content_revision_and_history_unchanged() {
    let runtime = attached().await;
    let before = read(&runtime).await;
    let archive = call(&runtime, "project.classic.session.archive", json!({"projectId":"classic-project"})).await;
    let input = json!({"projectId":"classic-project","sceneId":"other-scene","expectedRevision":before["revision"],"expectedNavigationRevision":0});
    runtime.registry().invoke("project.classic.scene.open", InvocationContext { dry_run:true, ..Default::default() }, input.clone()).await.unwrap();
    assert_eq!(read(&runtime).await, before);
    let opened = call(&runtime, "project.classic.scene.open", input.clone()).await;
    assert_eq!(opened["sceneId"], "other-scene");
    let after = read(&runtime).await;
    assert_eq!(after["revision"], before["revision"]);
    assert_eq!(after["project"], before["project"]);
    assert_eq!(after["workspace"]["classicScene"]["sceneId"], "other-scene");
    call(&runtime, "project.classic.viewport.set", json!({"projectId":"classic-project","expectedRevision":before["revision"],"zoomLevel":0.03,"scrollLeft":10,"playheadTime":120000})).await;
    let viewport = read(&runtime).await;
    assert_eq!(viewport["project"], before["project"]);
    assert_eq!(viewport["revision"], before["revision"]);
    assert_eq!(viewport["workspace"]["classicViewport"]["zoomLevel"], 0.03);
    assert!(runtime.registry().invoke("project.classic.viewport.set", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":before["revision"],"zoomLevel":0,"scrollLeft":10,"playheadTime":120000})).await.is_err());
    assert_eq!(call(&runtime, "project.classic.session.status", json!({"projectId":"classic-project"})).await["canUndo"], false);
    assert!(runtime.registry().invoke("project.classic.scene.open", InvocationContext::default(), input).await.is_err());
    let saved = call(&runtime, "project.classic.session.archive", json!({"projectId":"classic-project","compact":true,"chained":true})).await;
    assert_eq!(saved["schemaVersion"], 4);
    assert_eq!(saved["classic"], archive["classic"]);
    for invalid in ["missing", ""] {
        assert!(runtime.registry().invoke("project.classic.scene.open", InvocationContext::default(), json!({"projectId":"classic-project","sceneId":invalid,"expectedRevision":before["revision"]})).await.is_err());
        assert_eq!(read(&runtime).await, viewport);
    }
    let reopened = OpenCutRuntime::default();
    let mut corrupt = saved.clone(); corrupt["viewerSceneId"] = json!("missing");
    assert!(reopened.registry().invoke("project.classic.session.restore", InvocationContext::default(), json!({"projectId":"classic-project","expectedRevision":0,"archive":corrupt})).await.is_err());
    assert!(reopened.snapshot().unwrap().project.is_none());
    call(&reopened,"project.classic.session.restore",json!({"projectId":"classic-project","expectedRevision":0,"archive":saved})).await;
    assert_eq!(call(&reopened,"project.classic.scene.view",json!({"projectId":"classic-project"})).await["sceneId"],"other-scene");
}

async fn call(runtime: &OpenCutRuntime, id: &str, input: Value) -> Value {
    runtime
        .registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn attached() -> OpenCutRuntime {
    let runtime = OpenCutRuntime::default();
    let classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project", "expectedRevision":0, "classic":classic}),
    )
    .await;
    runtime
}
async fn read(runtime: &OpenCutRuntime) -> Value {
    call(runtime, "app.state.read", json!({})).await["value"].clone()
}
fn input(state: &Value, change: Value) -> Value {
    json!({"projectId":"classic-project", "expectedRevision":state["revision"], "change":change})
}
fn bookmark_input(state: &Value, change: Value) -> Value {
    let mut request = input(state, change);
    request["sceneId"] = json!("main-scene");
    request
}
fn ignore_project_time(mut project: Value) -> Value {
    project["classic"]["document"]["metadata"]["updatedAt"] = Value::Null;
    project
}

#[tokio::test]
async fn scene_automation_forks_and_publishes_without_touching_sources_or_navigation() {
    let runtime=attached().await;
    let before=read(&runtime).await;
    let recipe=json!({"zoom":true,"transitions":true,"wordAnimation":true,"music":true});
    let request=input(&before,json!({"type":"enqueue","jobs":[{"id":"job-a","sceneId":"main-scene","workerProjectId":"worker-a","outputSceneId":"output-a","action":"full-auto","options":recipe},{"id":"job-b","sceneId":"other-scene","workerProjectId":"worker-b","outputSceneId":"output-b","action":"zoom","options":recipe}]}));
    runtime.registry().invoke("project.classic.automation.edit",InvocationContext{dry_run:true,..Default::default()},request.clone()).await.unwrap();
    assert_eq!(read(&runtime).await,before);
    let result=call(&runtime,"project.classic.automation.edit",request).await;
    assert_eq!(result["workers"].as_array().unwrap().len(),2);
    let queued=read(&runtime).await;
    assert_eq!(queued["project"]["classic"]["document"]["scenes"],before["project"]["classic"]["document"]["scenes"]);
    let mut worker=queued["project"]["classic"].clone();
    worker["document"]=result["workers"][0]["project"].clone();
    worker["document"]["settings"]["canvasSize"]=json!({"width":1080,"height":1920});
    worker["document"]["scenes"][0]["name"]=json!("Edited result");
    call(&runtime,SCENES,input(&queued,json!({"type":"select","sceneId":"other-scene"}))).await;
    let switched=read(&runtime).await;
    let publish=input(&switched,json!({"type":"publish","jobId":"job-a","worker":worker}));
    call(&runtime,"project.classic.automation.edit",publish.clone()).await;
    let after=read(&runtime).await;
    let document=&after["project"]["classic"]["document"];
    assert_eq!(document["currentSceneId"],"other-scene");
    assert_eq!(document["settings"],before["project"]["classic"]["document"]["settings"]);
    let scenes=document["scenes"].as_array().unwrap();
    assert_eq!(&scenes[..2],before["project"]["classic"]["document"]["scenes"].as_array().unwrap());
    assert_eq!(scenes[2]["id"],"output-a");
    assert_eq!(scenes[2]["settings"]["canvasSize"],json!({"width":1080,"height":1920}));
    assert_ne!(scenes[2]["tracks"]["main"]["id"],scenes[0]["tracks"]["main"]["id"]);
    assert_eq!(document["automationEdits"][0]["status"],"published");
    let plan=call(&runtime,"project.classic.export.plan",json!({"projectId":"classic-project","expectedRevision":after["revision"],"sceneId":"output-a","preferences":{"resolution":"project","encoding":"compact"},"quality":"very_high","format":"mp4"})).await;
    assert_eq!(plan["logicalWidth"],1080);assert_eq!(plan["logicalHeight"],1920);

    // A resumed publication never duplicates the result.
    let mut replay=publish;replay["expectedRevision"]=after["revision"].clone();
    call(&runtime,"project.classic.automation.edit",replay).await;
    assert_eq!(read(&runtime).await["project"]["classic"]["document"]["scenes"].as_array().unwrap().len(),3);
    // Changing this scene's canvas leaves both project defaults and sources intact.
    let state=read(&runtime).await;
    call(&runtime,"project.classic.settings.update",json!({"projectId":"classic-project","sceneId":"output-a","expectedRevision":state["revision"],"settings":{"canvasSize":{"width":720,"height":1280}}})).await;
    let resized=read(&runtime).await;
    assert_eq!(resized["project"]["classic"]["document"]["settings"],document["settings"]);
    call(&runtime,"history.undo",json!({})).await;
    call(&runtime,"history.undo",json!({})).await;
    assert_eq!(read(&runtime).await["project"]["classic"]["document"]["scenes"],switched["project"]["classic"]["document"]["scenes"]);
}

#[tokio::test]
async fn scene_automation_rejects_unknown_scenes_and_stale_revisions_atomically() {
    let runtime=attached().await;let before=read(&runtime).await;
    for scene in ["missing","main-scene"] {
        let mut request=input(&before,json!({"type":"enqueue","jobs":[{"id":"a","sceneId":scene,"workerProjectId":"w","outputSceneId":"o","action":"full-auto","options":{"zoom":false,"transitions":false,"wordAnimation":false,"music":false}}]}));
        if scene=="main-scene" {request["expectedRevision"]=json!(0);}
        assert!(runtime.registry().invoke("project.classic.automation.edit",InvocationContext::default(),request).await.is_err());
        assert_eq!(read(&runtime).await,before);
    }
}

#[tokio::test]
async fn isolated_multicam_preparation_keeps_selected_angles_microphones_and_transcript() {
    for overlap in [false, true] {
        let source = OpenCutRuntime::default();
        let mut classic: Value = serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
        let scene = &mut classic["document"]["scenes"][0];
        let mut a = scene["tracks"]["main"]["elements"][0].clone();
        a.as_object_mut().unwrap().remove("retime");
        a["id"] = json!("camera-a"); a["enabled"] = json!(true); a["duration"] = json!(600000);
        a["isSourceAudioEnabled"] = json!(false);
        let mut b = a.clone(); b["id"] = json!("camera-b");
        b["startTime"] = json!(if overlap { 0 } else { 600000 });
        b["trimStart"] = json!(1080000);
        let mut alternative = a.clone(); alternative["id"] = json!("alternative"); alternative["enabled"] = json!(false);
        scene["tracks"]["main"]["elements"] = json!([]);
        scene["tracks"]["overlay"].as_array_mut().unwrap().extend([
            json!({"id":"routed-a","type":"video","name":"Routed A","hidden":false,"muted":true,"elements":[a,alternative]}),
            json!({"id":"routed-b","type":"video","name":"Routed B","hidden":false,"muted":true,"elements":[b]})
        ]);
        scene["tracks"]["audio"] = json!([{"id":"microphone","type":"audio","name":"Mic","muted":false,"elements":[{"id":"mic","type":"audio","mediaId":"video-asset","sourceType":"upload","startTime":0,"duration":1200000,"trimStart":30000,"trimEnd":0,"params":{"gainDb":-1,"volume":15,"noiseReduction":100,"hardLimiterEnabled":true}}]}]);
        call(&source,"project.classic.session.attach",json!({"projectId":"classic-project","expectedRevision":0,"classic":classic})).await;
        let before = read(&source).await;
        // The public source is never eligible for destructive preparation.
        assert!(source.registry().invoke("project.classic.automation.edit",InvocationContext::default(),input(&before,json!({"type":"prepare","sceneId":"main-scene"}))).await.is_err());
        let queued = call(&source,"project.classic.automation.edit",input(&before,json!({"type":"enqueue","jobs":[{"id":"job","sceneId":"main-scene","workerProjectId":"worker","outputSceneId":"output","action":"full-auto","options":{"zoom":true,"transitions":true,"wordAnimation":true,"music":true}}]}))).await;
        let mut worker_classic = before["project"]["classic"].clone();
        worker_classic["document"] = queued["workers"][0]["project"].clone();
        let worker = OpenCutRuntime::default();
        call(&worker,"project.classic.session.attach",json!({"projectId":"worker","expectedRevision":0,"classic":worker_classic})).await;
        let initial = read(&worker).await;
        let request = json!({"projectId":"worker","expectedRevision":initial["revision"],"change":{"type":"prepare","sceneId":"main-scene"}});
        if overlap {
            assert!(worker.registry().invoke("project.classic.automation.edit",InvocationContext::default(),request).await.is_err());
            assert_eq!(read(&worker).await,initial);
            continue;
        }
        worker.registry().invoke("project.classic.automation.edit",InvocationContext{dry_run:true,..Default::default()},request.clone()).await.unwrap();
        assert_eq!(read(&worker).await,initial);
        call(&worker,"project.classic.automation.edit",request).await;
        let prepared = read(&worker).await;
        let tracks = &prepared["project"]["classic"]["document"]["scenes"][0]["tracks"];
        assert_eq!(tracks["main"]["elements"][0]["id"],"camera-a");
        assert_eq!(tracks["main"]["elements"][1]["id"],"camera-b");
        assert_eq!(tracks["main"]["elements"][1]["trimStart"],1080000);
        assert_eq!(tracks["audio"],initial["project"]["classic"]["document"]["scenes"][0]["tracks"]["audio"]);
        assert_eq!(tracks["overlay"][0],initial["project"]["classic"]["document"]["scenes"][0]["tracks"]["overlay"][0]);
        assert_eq!(tracks["overlay"][1]["elements"][0]["id"],"alternative");
        assert_eq!(tracks["overlay"][1]["elements"][0]["enabled"],false);
        assert_eq!(read(&source).await["project"]["classic"]["document"]["scenes"],before["project"]["classic"]["document"]["scenes"]);
        call(&worker,"history.undo",json!({})).await;
        assert_eq!(read(&worker).await["project"],initial["project"]);
    }
}

#[tokio::test]
async fn scene_lifecycle_preserves_media_unknown_fields_and_restores_active_scene_through_history()
{
    let runtime = attached().await;
    let original = read(&runtime).await;
    let create = input(
        &original,
        json!({"type":"create", "sceneId":"third", "mainTrackId":"third-main", "name":"סצנה חדשה"}),
    );
    let preview = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    runtime
        .registry()
        .invoke(SCENES, preview, create.clone())
        .await
        .unwrap();
    assert_eq!(read(&runtime).await, original);
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("scene-create"));
    let receipt = runtime
        .registry()
        .invoke(SCENES, context.clone(), create.clone())
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke(SCENES, context, create)
            .await
            .unwrap(),
        receipt
    );
    let created = read(&runtime).await;
    let scene = created["project"]["classic"]["document"]["scenes"][2].clone();
    assert_eq!(
        scene["tracks"]["main"],
        json!({"id":"third-main", "name":"Main Track", "type":"video", "elements":[], "muted":false, "hidden":false})
    );
    assert_eq!(scene["tracks"]["order"], json!(["third-main"]));
    assert_eq!(scene["bookmarks"], json!([]));
    assert_eq!(scene["isMain"], false);
    assert!(chrono::DateTime::parse_from_rfc3339(scene["createdAt"].as_str().unwrap()).is_ok());
    let mut expected = original["project"].clone();
    expected["classic"]["document"]["scenes"]
        .as_array_mut()
        .unwrap()
        .push(scene);
    assert_eq!(
        ignore_project_time(created["project"].clone()),
        ignore_project_time(expected)
    );
    call(
        &runtime,
        SCENES,
        input(&created, json!({"type":"select", "sceneId":"third"})),
    )
    .await;
    let selected = read(&runtime).await;
    assert_eq!(
        selected["project"]["classic"]["document"]["currentSceneId"],
        "third"
    );
    call(
        &runtime,
        SCENES,
        input(
            &selected,
            json!({"type":"rename", "sceneId":"third", "name":"Renamed"}),
        ),
    )
    .await;
    let renamed = read(&runtime).await;
    call(&runtime, DELETE, json!({"projectId":"classic-project", "expectedRevision":renamed["revision"], "sceneId":"third"})).await;
    let deleted = read(&runtime).await;
    assert_eq!(
        deleted["project"]["classic"]["document"]["currentSceneId"],
        "main-scene"
    );
    assert_eq!(
        ignore_project_time(deleted["project"].clone()),
        ignore_project_time(original["project"].clone())
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], renamed["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], deleted["project"]);
    assert_eq!(
        runtime
            .registry()
            .snapshot()
            .unwrap()
            .capabilities
            .iter()
            .find(|d| d.id == DELETE)
            .unwrap()
            .access,
        AccessLevel::Write
    );
}

#[tokio::test]
async fn scene_edits_reject_invalid_targets_collisions_main_deletion_stale_revision_and_cancellation()
 {
    let runtime = attached().await;
    let before = read(&runtime).await;
    for change in [
        json!({"type":"create", "sceneId":"main-scene", "mainTrackId":"fresh", "name":"Duplicate"}),
        json!({"type":"create", "sceneId":"fresh", "mainTrackId":"text-1", "name":"Duplicate element ID"}),
        json!({"type":"create", "sceneId":"fresh", "mainTrackId":"other-main", "name":"Duplicate track ID"}),
        json!({"type":"create", "sceneId":"", "mainTrackId":"fresh", "name":"Bad"}),
        json!({"type":"rename", "sceneId":"main-scene", "name":" "}),
        json!({"type":"rename", "sceneId":"missing", "name":"Name"}),
        json!({"type":"select", "sceneId":"missing"}),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(SCENES, InvocationContext::default(), input(&before, change))
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
    for scene in ["main-scene", "missing"] {
        assert!(runtime.registry().invoke(DELETE, InvocationContext::default(), json!({"projectId":"classic-project", "expectedRevision":before["revision"], "sceneId":scene})).await.is_err());
    }
    let request = input(&before, json!({"type":"select", "sceneId":"other-scene"}));
    let mut wrong_project = request.clone();
    wrong_project["projectId"] = json!("other-project");
    assert!(
        runtime
            .registry()
            .invoke(SCENES, InvocationContext::default(), wrong_project)
            .await
            .is_err()
    );
    let cancelled = InvocationContext::default();
    cancelled.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke(SCENES, cancelled, request.clone())
            .await
            .is_err()
    );
    assert_eq!(read(&runtime).await, before);
    call(&runtime, SCENES, request.clone()).await;
    assert!(
        runtime
            .registry()
            .invoke(SCENES, InvocationContext::default(), request)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn bookmark_moves_preserve_duplicate_order_ranges_groups_and_unknown_metadata() {
    let runtime = attached().await;
    let initial = read(&runtime).await;
    let bookmarks = json!([
        {"time":4004, "note":"first", "color":"#ff00ff", "duration":8008, "groupId":"takes", "future":{"nested":true}},
        {"time":8008, "note":"second"}, {"time":8008, "note":"third"}
    ]);
    call(
        &runtime,
        BOOKMARKS,
        bookmark_input(&initial, json!({"type":"replace", "bookmarks":bookmarks})),
    )
    .await;
    let before = read(&runtime).await;
    let request = bookmark_input(
        &before,
        json!({"type":"move", "fromTime":4100, "toTime":7800}),
    );
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("move-marker"));
    let receipt = runtime
        .registry()
        .invoke(BOOKMARKS, context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke(BOOKMARKS, context, request)
            .await
            .unwrap(),
        receipt
    );
    let moved = read(&runtime).await;
    let mut expected = bookmarks.clone();
    expected[0]["time"] = json!(8008);
    assert_eq!(
        moved["project"]["classic"]["document"]["scenes"][0]["bookmarks"],
        expected
    );
    let mut preserved = before["project"].clone();
    preserved["classic"]["document"]["scenes"][0]["bookmarks"] = expected;
    assert_eq!(
        ignore_project_time(moved["project"].clone()),
        ignore_project_time(preserved)
    );
    call(&runtime, BOOKMARKS, bookmark_input(&moved, json!({"type":"update", "time":8000, "updates":{"note":"שלום", "clear":["color", "duration"]}}))).await;
    let updated = read(&runtime).await;
    assert_eq!(
        updated["project"]["classic"]["document"]["scenes"][0]["bookmarks"][0],
        json!({"time":8008, "note":"שלום", "groupId":"takes", "future":{"nested":true}})
    );
    call(
        &runtime,
        BOOKMARKS,
        bookmark_input(&updated, json!({"type":"toggle", "time":8008})),
    )
    .await;
    let toggled = read(&runtime).await;
    assert_eq!(
        toggled["project"]["classic"]["document"]["scenes"][0]["bookmarks"],
        json!([{"time":8008,"note":"second"},{"time":8008,"note":"third"}])
    );
    call(
        &runtime,
        BOOKMARKS,
        bookmark_input(&toggled, json!({"type":"remove", "time":8008})),
    )
    .await;
    let removed = read(&runtime).await;
    assert_eq!(
        removed["project"]["classic"]["document"]["scenes"][0]["bookmarks"],
        json!([])
    );
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], toggled["project"]);
    call(&runtime, "history.redo", json!({})).await;
    assert_eq!(read(&runtime).await["project"], removed["project"]);
}

#[tokio::test]
async fn invalid_bookmarks_fail_without_changing_any_scene_or_history() {
    let runtime = attached().await;
    let before = read(&runtime).await;
    for change in [
        json!({"type":"toggle", "time":-1}),
        json!({"type":"toggle", "time":1.5}),
        json!({"type":"toggle", "time":9007199254740992_i64}),
        json!({"type":"replace", "bookmarks":[{"time":0,"duration":-1}]}),
        json!({"type":"replace", "bookmarks":[{"time":9007199254740990_i64,"duration":2}]}),
        json!({"type":"replace", "bookmarks":[{"time":0,"note":3}]}),
        json!({"type":"update", "time":120000,"updates":{"note":"text","clear":["note"]}}),
        json!({"type":"update", "time":120000,"updates":{"clear":["future"]}}),
    ] {
        assert!(
            runtime
                .registry()
                .invoke(
                    BOOKMARKS,
                    InvocationContext::default(),
                    bookmark_input(&before, change)
                )
                .await
                .is_err()
        );
        assert_eq!(read(&runtime).await, before);
    }
    let preview = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    runtime
        .registry()
        .invoke(
            BOOKMARKS,
            preview,
            bookmark_input(&before, json!({"type":"toggle", "time":2002})),
        )
        .await
        .unwrap();
    assert_eq!(read(&runtime).await, before);
    let mut missing = bookmark_input(&before, json!({"type":"toggle", "time":0}));
    missing["sceneId"] = json!("missing");
    assert!(
        runtime
            .registry()
            .invoke(BOOKMARKS, InvocationContext::default(), missing)
            .await
            .is_err()
    );
    // Generic Classic replacement is subject to the same bookmark model validation.
    let mut invalid = before["project"]["classic"].clone();
    invalid["document"]["scenes"][1]["bookmarks"] = json!([{"time":-10}]);
    assert!(runtime.registry().invoke("project.classic.commit", InvocationContext::default(), json!({"projectId":"classic-project", "expectedRevision":before["revision"], "classic":invalid})).await.is_err());
    assert_eq!(read(&runtime).await, before);
}

#[tokio::test]
async fn push_broll_creates_nested_scene_atomically() {
    let runtime = attached().await;
    let original = read(&runtime).await;
    let request = json!({"projectId":"classic-project", "expectedRevision":original["revision"], "sceneId":"main-scene", "edge":"top", "startTime":120000,"duration":600000});
    runtime.registry().invoke("timeline.classic.push-broll.create", InvocationContext {dry_run:true, ..Default::default()}, request.clone()).await.unwrap();
    assert_eq!(read(&runtime).await, original);
    call(&runtime,"timeline.classic.push-broll.create",request).await;
    let state = read(&runtime).await;
    let scenes = state["project"]["classic"]["document"]["scenes"].as_array().unwrap();
    let parent = scenes.iter().find(|s|s["id"]=="main-scene").unwrap();
    let layer = &parent["tracks"]["overlay"][0]["elements"][0];
    assert_eq!(layer["effectType"], "push-broll");
    assert_eq!(layer["params"]["screenPercent"],40.0);
    let nested = scenes.iter().find(|s|s["id"] == layer["params"]["brollSceneId"]).unwrap();
    assert_eq!(nested["tracks"]["main"]["elements"],json!([]));
    assert_eq!(state["project"]["classic"]["document"]["currentSceneId"],"main-scene");
    let bad = json!({"projectId":"classic-project", "expectedRevision":state["revision"], "sceneId":"main-scene", "edge":"bottom", "startTime":0,"duration":600000,"screenPercent":101});
    assert!(runtime.registry().invoke("timeline.classic.push-broll.create",InvocationContext::default(),bad).await.is_err());
    assert_eq!(read(&runtime).await,state);
    call(&runtime, "history.undo", json!({})).await;
    assert_eq!(ignore_project_time(read(&runtime).await["project"].clone()), ignore_project_time(original["project"].clone()));
}

#[tokio::test]
async fn text_graphics_attach_populate_and_undo_through_registry() {
 let runtime=attached().await;let original=read(&runtime).await;
 let request=json!({"projectId":"classic-project","expectedRevision":original["revision"],"sceneId":"main-scene","trackId":"titles","elementId":"text-1","edge":"bottom"});
 runtime.registry().invoke("timeline.classic.text-graphics.create",InvocationContext{dry_run:true,..Default::default()},request.clone()).await.unwrap();
 assert_eq!(read(&runtime).await,original);
 call(&runtime,"timeline.classic.text-graphics.create",request).await;
 let attached=read(&runtime).await;
 let text=&attached["project"]["classic"]["document"]["scenes"][0]["tracks"]["overlay"][0]["elements"][0];
 assert_eq!(text["params"]["textGraphicsEdge"],"bottom");
 assert_eq!(text["duration"],original["project"]["classic"]["document"]["scenes"][0]["tracks"]["overlay"][0]["elements"][0]["duration"]);
 let scene_id=text["params"]["textGraphicsSceneId"].clone();
 call(&runtime,"timeline.classic.elements.insert",json!({"projectId":"classic-project","expectedRevision":attached["revision"],"sceneId":scene_id,"clips":[{"element":{"type":"video","name":"Graphic content video","mediaId":"video-asset","startTime":0,"duration":120000,"params":{}},"placement":{"mode":"auto"}}]})).await;
 let populated=read(&runtime).await;
 let nested=populated["project"]["classic"]["document"]["scenes"].as_array().unwrap().iter().find(|s|s["id"]==scene_id).unwrap();
 assert_eq!(nested["tracks"]["main"]["elements"][0]["mediaId"],"video-asset");
 assert_eq!(populated["project"]["classic"]["document"]["settings"],original["project"]["classic"]["document"]["settings"]);
 call(&runtime,"history.undo",json!({})).await;
 call(&runtime,"history.undo",json!({})).await;
 assert_eq!(ignore_project_time(read(&runtime).await["project"].clone()),ignore_project_time(original["project"].clone()));
}
