use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};
const CAP: &str = "transcription.classic.edit";
async fn call(r: &OpenCutRuntime, id: &str, input: Value) -> Value {
    r.registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .unwrap()
        .result
        .data
}
async fn state(r: &OpenCutRuntime) -> Value {
    call(r, "app.state.read", json!({})).await["value"].clone()
}
async fn edit(r: &OpenCutRuntime, change: Value) -> Value {
    let revision = state(r).await["revision"].clone();
    call(r,CAP,json!({"projectId":"classic-project","expectedRevision":revision,"jobId":"speech-job","change":change})).await
}
async fn setup() -> OpenCutRuntime {
    let r = OpenCutRuntime::default();
    let mut c: Value = serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    let e = &mut c["document"]["scenes"][0]["tracks"]["main"]["elements"][0];
    e["duration"] = json!(180 * 120000);
    e["trimStart"] = json!(0);
    e["trimEnd"] = json!(0);
    e["retime"] = json!({"rate":1});
    e["params"]["audioSyncOffset"] = json!(0);
    c["mediaAssets"][0]["duration"] = json!(180);
    call(
        &r,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":c}),
    )
    .await;
    edit(&r,json!({"type":"start","sceneId":"main-scene","language":"he","settings":{"wordsPerRow":3,"rows":1},"defaults":{"element":{"type":"text","trimStart":0,"trimEnd":0,"params":{"opacity":1}},"bottomFadeOutEndOpacity":0.25},"totalDuration":180*120000})).await;
    r
}
fn job(s: &Value) -> &Value {
    &s["project"]["classic"]["document"]["transcriptionJobs"][0]
}
fn tracks(s: &Value) -> Vec<&Value> {
    s["project"]["classic"]["document"]["scenes"][0]["tracks"]["overlay"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["captionSource"]["sourceId"] == "speech-job")
        .collect()
}
fn captions(s: &Value) -> usize {
    tracks(s)
        .iter()
        .map(|t| t["elements"].as_array().unwrap().len())
        .sum()
}
fn section(index: usize) -> Value {
    json!({"type":"append","index":index,"words":[{"text":format!("word-{index}"),"start":index as f64*60.0+1.0,"end":index as f64*60.0+2.0}]})
}
#[tokio::test]
async fn chunks_publish_immediately_and_replay_without_duplicate_cues() {
    let r = setup().await;
    edit(&r, section(0)).await;
    let first = state(&r).await;
    assert!(captions(&first) > 0);
    assert_eq!(job(&first)["chunks"]["0"][0]["text"], "word-0");
    assert_eq!(job(&first)["status"], "running");
    edit(&r, section(0)).await;
    assert_eq!(captions(&state(&r).await), captions(&first));
    edit(&r, section(1)).await;
    let next = state(&r).await;
    assert!(captions(&next) > captions(&first));
    let old_ids: Vec<_> = tracks(&first)
        .iter()
        .flat_map(|t| t["elements"].as_array().unwrap())
        .map(|e| e["id"].clone())
        .collect();
    for id in old_ids {
        assert!(
            tracks(&next)
                .iter()
                .flat_map(|t| t["elements"].as_array().unwrap())
                .any(|e| e["id"] == id)
        );
    }
    edit(&r, section(2)).await;
    assert_eq!(job(&state(&r).await)["status"], "complete");
}
#[tokio::test]
async fn move_and_scene_selection_do_not_discard_pending_words() {
    let r = setup().await;
    edit(&r, section(0)).await;
    let revision = state(&r).await["revision"].clone();
    call(&r,"timeline.classic.elements.move",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":revision,"moves":[{"sourceTrackId":"video-track","elementId":"item-2","targetTrackId":"video-track","newStartTime":20*120000}]})).await;
    let revision = state(&r).await["revision"].clone();
    call(&r,"project.classic.scenes.edit",json!({"projectId":"classic-project","expectedRevision":revision,"change":{"type":"select","sceneId":"other-scene"}})).await;
    edit(&r, section(1)).await;
    let s = state(&r).await;
    assert_eq!(
        s["project"]["classic"]["document"]["currentSceneId"],
        "other-scene"
    );
    assert!(
        tracks(&s)
            .iter()
            .flat_map(|t| t["captionSource"]["words"].as_array().unwrap())
            .any(|w| w["text"] == "word-1" && w["start"] == 81.0)
    );
    assert_eq!(
        job(&s)["sourceTracks"]["main"]["elements"][0]["startTime"],
        0
    );
}
#[tokio::test]
async fn removed_sources_keep_durable_words_without_orphaned_captions() {
    let r = setup().await;
    let revision = state(&r).await["revision"].clone();
    call(&r,"timeline.classic.remove",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":revision,"removal":{"type":"elements","elements":[{"trackId":"video-track","elementId":"item-2"}]}})).await;
    edit(&r, section(0)).await;
    let s = state(&r).await;
    assert_eq!(captions(&s), 0);
    assert_eq!(job(&s)["chunks"]["0"].as_array().unwrap().len(), 1);
}
#[tokio::test]
async fn validates_scope_replay_and_dry_run_and_retains_job_on_reload() {
    let r = setup().await;
    edit(&r, section(0)).await;
    let s = state(&r).await;
    let d = r.registry().descriptor(CAP).unwrap().unwrap();
    assert_eq!(d.access, AccessLevel::Write);
    assert!(!d.open_world);
    for change in [
        json!({"type":"append","index":0,"words":[]}),
        json!({"type":"append","index":1000,"words":[]}),
    ] {
        assert!(r.registry().invoke(CAP,InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":s["revision"],"jobId":"speech-job","change":change})).await.is_err());
    }
    let dry = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    r.registry().invoke(CAP,dry,json!({"projectId":"classic-project","expectedRevision":s["revision"],"jobId":"speech-job","change":section(1)})).await.unwrap();
    assert_eq!(state(&r).await, s);
    let restored = OpenCutRuntime::default();
    call(&restored,"project.classic.session.attach",json!({"projectId":"classic-project","expectedRevision":0,"classic":s["project"]["classic"]})).await;
    assert_eq!(job(&state(&restored).await), job(&s));
    edit(&restored, section(1)).await;
    assert!(captions(&state(&restored).await) > captions(&s));
    edit(&restored, json!({"type":"pause"})).await;
    assert_eq!(job(&state(&restored).await)["status"], "paused");
}

#[tokio::test]
async fn restore_after_undo_uses_original_source_and_republishes_completed_work() {
    let r = setup().await;
    edit(&r, section(0)).await;
    let snapshot = job(&state(&r).await).clone();
    call(&r, "history.undo", json!({})).await;
    edit(&r, json!({"type":"restore","snapshot":snapshot})).await;
    edit(&r, section(0)).await;
    edit(&r, section(1)).await;
    let s = state(&r).await;
    assert_eq!(job(&s)["chunks"].as_object().unwrap().len(), 2);
    assert!(captions(&s) > 0);
}

#[tokio::test]
async fn retiming_and_manual_caption_edits_survive_new_sections() {
    let r = setup().await;
    edit(&r, section(0)).await;
    let s = state(&r).await;
    let t = tracks(&s)[0];
    let id = t["elements"][0]["id"].clone();
    let track_id = t["id"].clone();
    call(&r,"timeline.classic.elements.update",json!({"projectId":"classic-project","sceneId":"main-scene","expectedRevision":s["revision"],"updates":[{"trackId":track_id,"elementId":id,"patch":{"params":{"opacity":0.4}}},{"trackId":"video-track","elementId":"item-2","patch":{"retime":{"rate":2},"duration":90*120000}}]})).await;
    let before = state(&r).await;
    let old = tracks(&before)
        .iter()
        .flat_map(|t| t["elements"].as_array().unwrap())
        .find(|e| e["id"] == id)
        .unwrap()
        .clone();
    edit(&r, section(1)).await;
    let after = state(&r).await;
    assert_eq!(
        *tracks(&after)
            .iter()
            .flat_map(|t| t["elements"].as_array().unwrap())
            .find(|e| e["id"] == id)
            .unwrap(),
        old
    );
    assert!(
        tracks(&after)
            .iter()
            .flat_map(|t| t["captionSource"]["words"].as_array().unwrap())
            .any(|w| w["text"] == "word-1" && w["start"] == 30.5)
    );
}

#[tokio::test]
async fn srt_import_preserves_cues_supersedes_pending_inference_and_exposes_transcript() {
    let r = setup().await;
    edit(&r, section(0)).await;
    let before = state(&r).await;
    let defaults = job(&before)["defaults"].clone();
    edit(&r,json!({"type":"importSrt","sceneId":"main-scene","text":"\u{feff}1\r\n00:00:02,250 --> 00:00:04,750\r\nשלום <i>עולם</i>\r\n\r\n2\r\n00:01:01.000 --> 00:01:04.000\r\nSecond line\r\ncontinued","settings":{"wordsPerRow":3,"rows":1},"defaults":defaults})).await;
    let s = state(&r).await;
    assert_eq!(job(&s)["status"], "superseded");
    let imported = tracks(&s);
    assert_eq!(imported.len(), 1);
    assert_eq!(imported[0]["elements"].as_array().unwrap().len(), 2);
    assert_eq!(imported[0]["elements"][0]["startTime"], 270000);
    assert_eq!(imported[0]["elements"][0]["duration"], 300000);
    assert_eq!(imported[0]["captionSource"]["origin"], "srt");
    assert_eq!(imported[0]["captionSource"]["words"][0]["text"], "שלום");
    assert_eq!(
        imported[0]["captionSource"]["words"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    call(&r, "history.undo", json!({})).await; // grouped transcription edits are undoable
}
#[tokio::test]
async fn malformed_srt_is_atomic_and_engine_selection_is_canonical() {
    let r = setup().await;
    edit(&r, json!({"type":"setEngine","engine":"external"})).await;
    let before = state(&r).await;
    assert_eq!(
        before["project"]["classic"]["document"]["transcriptionEngine"],
        "external"
    );
    for text in [
        "",
        "1\n00:60:00,000 --> 00:61:00,000\ninvalid",
        "1\n00:00:01,000 --> 00:00:00,500\nbackwards",
        "1\n00:00:01,000 --> 00:00:02,000\ngood\n\n2\ninvalid",
    ] {
        let error=r.registry().invoke(CAP,InvocationContext::default(),json!({"projectId":"classic-project","expectedRevision":before["revision"],"jobId":"import-job","change":{"type":"importSrt","sceneId":"main-scene","text":text,"settings":{},"defaults":job(&before)["defaults"]}})).await;
        assert!(error.is_err());
        assert_eq!(state(&r).await, before);
    }
}
