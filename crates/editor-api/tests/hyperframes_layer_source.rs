use opencut_editor_api::{
    AccessLevel, HyperframesLayerSource, HyperframesRuntimeManifest, HyperframesSource,
    HyperframesSourceResolution, InvocationContext, OpenCutRuntime, read_hyperframes_layer_source,
};
use serde_json::{Value, json};

fn source(html: &str) -> HyperframesSource {
    serde_json::from_value(json!({"entryFile":"index.html","files":{
        "index.html":"<div data-composition-id=main data-width=320 data-height=180 data-duration=4></div>",
        "nested/layer.html":html
    }})).unwrap()
}

fn manifest(source: &HyperframesSource, ids: &[&str]) -> HyperframesRuntimeManifest {
    serde_json::from_value(json!({
        "sourceFingerprint":source.fingerprint(), "runtimeVersion":"0.8.115", "durationSeconds":4,
        "layers":ids.iter().enumerate().map(|(index,id)|json!({
            "key":format!("dom/1/{index}/0"),"parentKey":null,"file":"nested/layer.html",
            "elementId":id,"label":id,"kind":"element","startSeconds":0,"durationSeconds":4,
            "trackIndex":0,"resourcePath":null,"playbackStartSeconds":0,"playbackRate":1,"media":null
        })).collect::<Vec<_>>()
    })).unwrap()
}

fn locate(html: &str, id: &str) -> HyperframesLayerSource {
    let source = source(html);
    read_hyperframes_layer_source(&source, &manifest(&source, &[id]), "dom/1/0/0").unwrap()
}

#[test]
fn finds_exact_raw_bytes_and_textarea_offsets_with_unicode_entities_and_newlines() {
    let prefix = "<!doctype html>\r\n<!-- שלום 😀 -->\r\n<p>one</p>\r  ";
    let opening = "<DIV data-start='1'\r\n id='a&amp;ב😀' title='1 > 0'>";
    let html = format!("{prefix}{opening}text</DIV>");
    let result = locate(&html, "a&ב😀");
    assert_eq!(result.resolution, HyperframesSourceResolution::Located);
    let location = result.location.unwrap();
    assert_eq!(&html[location.start_byte..location.end_byte], opening);
    assert_eq!(location.start_byte, prefix.len());
    assert_eq!(location.line, 4);
    assert_eq!(location.column, 3);
    let displayed = html
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .encode_utf16()
        .collect::<Vec<_>>();
    assert_eq!(
        String::from_utf16(&displayed[location.start_textarea..location.end_textarea]).unwrap(),
        opening.replace("\r\n", "\n")
    );
    assert_eq!(result.reported_occurrences, 1);
    assert_eq!(result.tag.as_deref(), Some("div"));
}

#[test]
fn skips_fake_tags_in_raw_text_comments_and_inert_template_content() {
    let fake = r#"<!-- <div id="target"> --><script>const s = '<div id="target">';</script><style>/* <div id="target"> */</style><textarea><div id="target"></textarea><title><div id="target"></title>"#;
    let html = format!("{fake}<svg><path id='target' d='M0 0'/></svg>");
    let result = locate(&html, "target");
    assert_eq!(result.resolution, HyperframesSourceResolution::Located);
    let span = result.location.unwrap();
    assert_eq!(
        &html[span.start_byte..span.end_byte],
        "<path id='target' d='M0 0'/>"
    );
    assert_eq!(
        locate(fake, "target").resolution,
        HyperframesSourceResolution::Unresolved
    );
    assert_eq!(
        locate("<template><div id='target'></div></template>", "target").resolution,
        HyperframesSourceResolution::Unresolved
    );
}

#[test]
fn locates_svg_case_adjusted_names_and_namespaced_attributes() {
    let html = "<svg id='art' viewBox='0 0 100 100'><defs><linearGradient id='gradient' gradientUnits='userSpaceOnUse'></linearGradient></defs><use id='shape' xlink:href='#art'/></svg>";
    for (id, expected) in [
        ("art", "<svg id='art' viewBox='0 0 100 100'>"),
        (
            "gradient",
            "<linearGradient id='gradient' gradientUnits='userSpaceOnUse'>",
        ),
        ("shape", "<use id='shape' xlink:href='#art'/>"),
    ] {
        let result = locate(html, id);
        assert_eq!(result.resolution, HyperframesSourceResolution::Located);
        let span = result.location.unwrap();
        assert_eq!(&html[span.start_byte..span.end_byte], expected);
    }
}

#[test]
fn unresolved_and_ambiguous_layers_never_get_a_guessed_location() {
    for (html, resolution) in [
        (
            "<div id='x'></div><div id='x'></div>",
            HyperframesSourceResolution::Ambiguous,
        ),
        (
            "<div id='x'></div><div data-hf-id='x'></div>",
            HyperframesSourceResolution::Ambiguous,
        ),
        (
            "<div id='other'></div>",
            HyperframesSourceResolution::Unresolved,
        ),
        (
            "<div id='first' id='x'></div>",
            HyperframesSourceResolution::Unresolved,
        ),
        (
            "<script>document.body.innerHTML='<div id=x>'</script>",
            HyperframesSourceResolution::Unresolved,
        ),
    ] {
        let result = locate(html, "x");
        assert_eq!(result.resolution, resolution, "{html}");
        assert!(result.location.is_none());
    }
    let source = source("<div id=x></div>");
    for (field, value) in [
        ("file", Value::Null),
        ("elementId", Value::Null),
        ("elementId", json!("")),
        ("key", json!("manifest/0")),
    ] {
        let mut manifest = serde_json::to_value(manifest(&source, &["x"])).unwrap();
        manifest["layers"][0][field] = value;
        let key = manifest["layers"][0]["key"].as_str().unwrap().to_owned();
        let result = read_hyperframes_layer_source(
            &source,
            &serde_json::from_value(manifest).unwrap(),
            &key,
        )
        .unwrap();
        assert!(result.location.is_none());
    }
}

#[test]
fn resolves_composition_and_hf_ids_and_counts_repeated_nested_source_uses() {
    let source = source(
        "<div data-composition-id='child'><p id='title' data-hf-id='hf-title'>Title</p></div>",
    );
    let mut manifest = manifest(&source, &["title", "title", "hf-title", "child"]);
    manifest.layers[3].kind = opencut_editor_api::HyperframesLayerKind::Composition;
    let before = source.clone();
    for index in 0..3 {
        let result =
            read_hyperframes_layer_source(&source, &manifest, &format!("dom/1/{index}/0")).unwrap();
        assert_eq!(result.resolution, HyperframesSourceResolution::Located);
        assert_eq!(result.reported_occurrences, 3);
    }
    let result = read_hyperframes_layer_source(&source, &manifest, "dom/1/3/0").unwrap();
    assert_eq!(result.resolution, HyperframesSourceResolution::Located);
    assert_eq!(result.reported_occurrences, 1);
    assert_eq!(source, before);
}

#[test]
fn locates_mounted_composition_templates_but_not_plain_nested_clone_templates() {
    for html in [
        "<template><div data-composition-id=child><span id=target>Title</span></div></template>",
        "<template data-composition-id=child><span id=target>Title</span></template>",
    ] {
        let result = locate(html, "target");
        assert_eq!(result.resolution, HyperframesSourceResolution::Located);
        let span = result.location.unwrap();
        assert_eq!(&html[span.start_byte..span.end_byte], "<span id=target>");
    }
    let result = locate(
        "<template><div data-composition-id=child><template><span id=target></span></template></div></template>",
        "target",
    );
    assert_eq!(result.resolution, HyperframesSourceResolution::Unresolved);
}

#[tokio::test]
async fn registry_read_is_pure_validated_cancellable_and_closed_world() {
    let runtime = OpenCutRuntime::default();
    let source = source("<div id=target></div>");
    let input =
        json!({"source":source,"manifest":manifest(&source,&["target"]),"layerKey":"dom/1/0/0"});
    let state = runtime
        .registry()
        .invoke("app.state.read", InvocationContext::default(), json!({}))
        .await
        .unwrap()
        .result
        .data;
    let descriptor = runtime
        .registry()
        .descriptor("hyperframes.layer.source.read")
        .unwrap()
        .unwrap();
    assert_eq!(descriptor.access, AccessLevel::Read);
    assert!(descriptor.cancellable);
    assert!(!descriptor.open_world);
    let result = runtime
        .registry()
        .invoke(
            "hyperframes.layer.source.read",
            InvocationContext::default(),
            input.clone(),
        )
        .await
        .unwrap()
        .result
        .data;
    assert_eq!(result["resolution"], "located");
    for (field, value) in [("layerKey", json!("missing")), ("extra", json!(true))] {
        let mut bad = input.clone();
        bad[field] = value;
        assert!(
            runtime
                .registry()
                .invoke(
                    "hyperframes.layer.source.read",
                    InvocationContext::default(),
                    bad
                )
                .await
                .is_err()
        );
    }
    let mut stale = input.clone();
    stale["source"]["files"]["nested/layer.html"] = json!("<div id=changed></div>");
    assert!(
        runtime
            .registry()
            .invoke(
                "hyperframes.layer.source.read",
                InvocationContext::default(),
                stale
            )
            .await
            .is_err()
    );
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke("hyperframes.layer.source.read", context, input)
            .await
            .is_err()
    );
    let after = runtime
        .registry()
        .invoke("app.state.read", InvocationContext::default(), json!({}))
        .await
        .unwrap()
        .result
        .data;
    assert_eq!(state, after);
}
