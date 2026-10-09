use opencut_editor_api::{InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

fn classic(name: &str) -> Value {
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["document"]["metadata"]["name"] = json!(name);
    classic
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

async fn session(runtime: &OpenCutRuntime) -> Value {
    call(
        runtime,
        "project.classic.session.read",
        json!({"projectId":"classic-project"}),
    )
    .await
}

fn attach_input() -> Value {
    json!({"projectId":"classic-project", "expectedRevision":0, "classic":classic("Current"),
        "undoStack":[
            {"label":"First edit", "classic":classic("Original"), "hostContext":{"callbackId":"first", "selection":{"elements":[]}}},
            {"label":"Second edit", "classic":classic("First"), "hostContext":{"callbackId":"second"}}
        ],
        "redoStack":[
            {"label":"Fourth edit", "classic":classic("Fourth"), "hostContext":{"callbackId":"fourth"}},
            {"label":"Third edit", "classic":classic("Third"), "hostContext":{"callbackId":"third"}}
        ]
    })
}

#[tokio::test]
async fn adoption_preserves_stack_order_selection_context_and_reopen() {
    let runtime = OpenCutRuntime::default();
    let input = attach_input();
    let mut context = InvocationContext {
        dry_run: true,
        ..Default::default()
    };
    context
        .metadata
        .insert("opencut/idempotencyKey".into(), json!("adoption"));
    context
        .metadata
        .insert("opencut/projectId".into(), json!("classic-project"));
    runtime
        .registry()
        .invoke(
            "project.classic.session.attach",
            context.clone(),
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(runtime.snapshot().unwrap().revision, 0);
    context.dry_run = false;
    let receipt = runtime
        .registry()
        .invoke(
            "project.classic.session.attach",
            context.clone(),
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        runtime
            .registry()
            .invoke("project.classic.session.attach", context, input.clone())
            .await
            .unwrap(),
        receipt
    );
    let adopted = session(&runtime).await;
    assert_eq!(
        call(&runtime, "app.state.read", json!({})).await["value"]["project"]["classic"],
        adopted["classic"]
    );
    assert_eq!(adopted["undoStack"], input["undoStack"]);
    assert_eq!(adopted["redoStack"], input["redoStack"]);
    for (action, name, callback) in [
        ("history.redo", "Third", "third"),
        ("history.redo", "Fourth", "fourth"),
        ("history.undo", "Third", "fourth"),
        ("history.undo", "Current", "third"),
        ("history.undo", "First", "second"),
        ("history.undo", "Original", "first"),
        ("history.redo", "First", "first"),
    ] {
        let output = call(&runtime, action, json!({})).await;
        assert_eq!(output["hostContext"]["callbackId"], callback);
        assert_eq!(session(&runtime).await["classic"], classic(name));
    }
    let saved = session(&runtime).await;
    let reopened = OpenCutRuntime::default();
    call(
        &reopened,
        "project.classic.session.attach",
        json!({
            "projectId":"classic-project", "expectedRevision":0, "classic":saved["classic"],
            "undoStack":saved["undoStack"], "redoStack":saved["redoStack"]
        }),
    )
    .await;
    let mut actual = session(&reopened).await;
    assert_eq!(
        reopened.snapshot().unwrap().project,
        runtime.snapshot().unwrap().project
    );
    actual["revision"] = saved["revision"].clone();
    assert_eq!(actual, saved);
    call(&reopened, "history.redo", json!({})).await;
    assert_eq!(session(&reopened).await["classic"], classic("Current"));

    // A new capability edit joins the adopted history and truncates old redo.
    let revision = reopened.snapshot().unwrap().revision;
    let mut context = InvocationContext::default();
    context.metadata.insert(
        "opencut/historyContext".into(),
        json!({"callbackId":"new-edit"}),
    );
    reopened.registry().invoke("project.classic.commit", context, json!({"projectId":"classic-project", "expectedRevision":revision, "classic":classic("New")})).await.unwrap();
    assert_eq!(session(&reopened).await["redoStack"], json!([]));
    let undo = call(&reopened, "history.undo", json!({})).await;
    assert_eq!(undo["hostContext"]["callbackId"], "new-edit");
    assert_eq!(session(&reopened).await["classic"], classic("Current"));
    call(&reopened, "history.undo", json!({})).await;
    assert_eq!(session(&reopened).await["classic"], classic("First"));
}

#[tokio::test]
async fn invalid_adoption_and_stale_history_requests_are_atomic() {
    let runtime = OpenCutRuntime::default();
    let empty = runtime.snapshot().unwrap();
    for field in ["undoStack", "redoStack"] {
        let mut input = attach_input();
        input[field][1]["classic"]["document"]["metadata"]["id"] = json!("other-project");
        assert!(
            runtime
                .registry()
                .invoke(
                    "project.classic.session.attach",
                    InvocationContext::default(),
                    input
                )
                .await
                .is_err()
        );
        assert_eq!(runtime.snapshot().unwrap(), empty);
    }
    call(&runtime, "project.classic.session.attach", attach_input()).await;
    let before = session(&runtime).await;
    assert!(
        runtime
            .registry()
            .invoke(
                "project.classic.session.attach",
                InvocationContext::default(),
                attach_input()
            )
            .await
            .is_err()
    );
    for id in ["history.undo", "history.redo"] {
        for metadata in [
            json!({"opencut/expectedRevision":0}),
            json!({"opencut/projectId":"other-project"}),
        ] {
            let context = InvocationContext {
                metadata: metadata.as_object().unwrap().clone(),
                ..Default::default()
            };
            assert!(
                runtime
                    .registry()
                    .invoke(id, context, json!({}))
                    .await
                    .is_err()
            );
            assert_eq!(session(&runtime).await, before);
        }
    }
}

#[tokio::test]
async fn adoption_and_new_edits_keep_classics_complete_live_history() {
    let runtime = OpenCutRuntime::default();
    let mut input = attach_input();
    input["undoStack"] = json!(
        (0..205)
            .map(|index| json!({
                "label":format!("Edit {index}"), "classic":classic(&format!("Before {index}"))
            }))
            .collect::<Vec<_>>()
    );
    input["redoStack"] = json!([]);
    call(&runtime, "project.classic.session.attach", input).await;
    let checkpoint = runtime.begin_atomic().unwrap();
    let context = InvocationContext {
        metadata: json!({"opencut/transaction":true})
            .as_object()
            .unwrap()
            .clone(),
        ..Default::default()
    };
    runtime
        .registry()
        .invoke(
            "project.classic.commit",
            context,
            json!({
                "projectId":"classic-project", "expectedRevision":1, "classic":classic("New edit")
            }),
        )
        .await
        .unwrap();
    runtime.commit_atomic(checkpoint, "New edit").unwrap();
    assert_eq!(
        session(&runtime).await["undoStack"]
            .as_array()
            .unwrap()
            .len(),
        206
    );
    let archive = call(
        &runtime,
        "project.classic.session.archive",
        json!({"projectId":"classic-project","persistableOnly":true}),
    )
    .await;
    assert_eq!(archive["undoStack"].as_array().unwrap().len(), 100);
    for _ in 0..206 {
        call(&runtime, "history.undo", json!({})).await;
    }
    let state = session(&runtime).await;
    assert_eq!(state["classic"], classic("Before 0"));
    assert_eq!(state["undoStack"], json!([]));
    assert_eq!(state["redoStack"].as_array().unwrap().len(), 206);
}
