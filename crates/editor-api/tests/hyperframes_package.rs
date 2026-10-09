use opencut_editor_api::{AccessLevel, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

async fn plan(files: Value, entry: Option<&str>) -> Result<Value, String> {
    let runtime = OpenCutRuntime::full_access().unwrap();
    let descriptor = runtime
        .registry()
        .descriptor("hyperframes.package.plan")
        .unwrap()
        .unwrap();
    assert_eq!(descriptor.access, AccessLevel::Read);
    let before = runtime.snapshot().unwrap();
    let receipt = runtime
        .registry()
        .invoke(
            "hyperframes.package.plan",
            InvocationContext::default(),
            json!({"files": files, "entryFile": entry}),
        )
        .await
        .map_err(|e| e.to_string());
    assert_eq!(runtime.snapshot().unwrap(), before);
    receipt.map(|r| r.result.data)
}

#[tokio::test]
async fn folder_plan_keeps_source_fonts_binary_data_and_dynamic_assets() {
    let result = plan(
        json!([
            {"path":"index.html","size":101},
            {"path":"scenes/intro.html","size":51},
            {"path":"assets/עברית.woff2","size":1200},
            {"path":"assets/voice.wav","size":5000},
            {"path":"assets/runtime.wasm","size":8000},
            {"path":"assets/dynamic.json","size":20},
            {"path":"output/used-by-script.png","size":400},
            {"path":"node_modules/gsap/index.js","size":1000000},
            {"path":".git/objects/unused","size":1000000}
        ]),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result["entryFile"], "index.html");
    assert_eq!(result["sourceBytes"], 172);
    assert_eq!(result["resourceBytes"], 14600);
    assert_eq!(result["ignoredPaths"].as_array().unwrap().len(), 2);
    let files = result["files"].as_array().unwrap();
    assert!(files.iter().any(|f| f["mimeType"] == "font/woff2"
        && f["mediaType"] == "file"
        && f["kind"] == "resource"));
    assert!(
        files
            .iter()
            .any(|f| f["path"] == "output/used-by-script.png")
    );
    assert!(
        files
            .iter()
            .any(|f| f["path"] == "assets/dynamic.json" && f["kind"] == "source")
    );
}

#[tokio::test]
async fn entry_selection_is_explicit_when_the_folder_has_multiple_nonstandard_entries() {
    let files = json!([{"path":"a.html","size":1},{"path":"b.htm","size":1}]);
    let result = plan(files.clone(), None).await.unwrap();
    assert!(result["entryFile"].is_null());
    assert_eq!(result["entryCandidates"], json!(["a.html", "b.htm"]));
    assert_eq!(
        plan(files.clone(), Some("b.htm")).await.unwrap()["entryFile"],
        "b.htm"
    );
    assert!(plan(files, Some("missing.html")).await.is_err());
}

#[tokio::test]
async fn unsafe_colliding_or_oversized_packages_never_reach_storage() {
    for path in ["../secret", "C:/secret", "a\\b", "//host/share", "a/./b"] {
        assert!(
            plan(
                json!([{"path":"index.html","size":1},{"path":path,"size":1}]),
                None
            )
            .await
            .is_err(),
            "{path}"
        );
    }
    for files in [
        json!([{"path":"index.html","size":16*1024*1024+1}]),
        json!([{"path":"index.html","size":1},{"path":"index.html","size":1}]),
        json!([{"path":"only.css","size":1}]),
    ] {
        assert!(plan(files, None).await.is_err());
    }
}

#[tokio::test]
async fn virtual_package_urls_preserve_case_instead_of_aliasing_distinct_assets() {
    let result = plan(
        json!([
            {"path":"index.html","size":1},
            {"path":"assets/Logo.png","size":10},
            {"path":"assets/logo.png","size":20}
        ]),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result["files"].as_array().unwrap().len(), 3);
    assert_eq!(result["resourceBytes"], 30);
}
