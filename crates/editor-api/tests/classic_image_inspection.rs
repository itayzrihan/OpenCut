use opencut_editor_api::{AccessLevel, DocumentSupport, InvocationContext, OpenCutRuntime};
use serde_json::{Value, json};

const CAP: &str = "media.classic.image.inspect";
fn png_bytes(color: png::ColorType, depth: png::BitDepth, bytes: &[u8], palette: bool) -> Vec<u8> {
    let mut encoded = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut encoded, 3, 2);
        encoder.set_color(color);
        encoder.set_depth(depth);
        if palette {
            encoder.set_palette(vec![250, 0, 0, 0, 250, 0]);
            encoder.set_trns(vec![0, 255]);
        }
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(bytes).unwrap();
    }
    encoded
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
async fn state(runtime: &OpenCutRuntime) -> Value {
    call(runtime, "app.state.read", json!({})).await["value"].clone()
}
async fn setup(
    bytes: Vec<u8>,
    mime: &str,
    metadata_width: u32,
    checksum: Option<&str>,
) -> OpenCutRuntime {
    let runtime = OpenCutRuntime::default();
    let artifact = runtime
        .artifacts()
        .put(bytes, mime, Some(metadata_width), Some(2), None)
        .unwrap();
    let mut classic: Value =
        serde_json::from_str(include_str!("fixtures/classic-project.json")).unwrap();
    classic["mediaAssets"].as_array_mut().unwrap().push(json!({"id":"png-image","type":"image","name":"Inspection fixture","generation":{"artifactId":artifact.id,"sha256":checksum.unwrap_or(&artifact.sha256)}}));
    call(
        &runtime,
        "project.classic.session.attach",
        json!({"projectId":"classic-project","expectedRevision":0,"classic":classic}),
    )
    .await;
    runtime
}
fn input() -> Value {
    json!({"projectId":"classic-project","expectedRevision":1,"mediaId":"png-image"})
}

#[tokio::test]
async fn decoded_alpha_bounds_colors_and_sha_are_source_evidence_without_document_or_history_changes()
 {
    // Hidden RGB deliberately differs: it must not leak into visible statistics.
    let rgba = [
        255, 0, 255, 0, 10, 20, 30, 255, 200, 0, 0, 127, 20, 40, 60, 128, 250, 250, 250, 0, 30, 60,
        90, 255,
    ];
    let runtime = setup(
        png_bytes(png::ColorType::Rgba, png::BitDepth::Eight, &rgba, false),
        "image/png",
        3,
        None,
    )
    .await;
    let before = state(&runtime).await;
    let status = call(
        &runtime,
        "project.classic.session.status",
        json!({"projectId":"classic-project"}),
    )
    .await;
    let descriptor = runtime.registry().descriptor(CAP).unwrap().unwrap();
    assert_eq!(descriptor.access, AccessLevel::Read);
    assert_eq!(descriptor.document_support, DocumentSupport::Classic);
    assert!(descriptor.cancellable && !descriptor.open_world);
    let result = call(&runtime, CAP, input()).await;
    assert_eq!(result["transparentPixels"], 2);
    assert_eq!(result["opaquePixels"], 2);
    assert_eq!(result["partialAlphaPixels"], 2);
    assert_eq!(result["decodedHasAlpha"], true);
    assert_eq!(
        result["visibleBounds"],
        json!({"x":0,"y":0,"width":3,"height":2,"centerX":1.0,"centerY":0.5})
    );
    assert_eq!(result["centerRgba"], json!([250, 250, 250, 0]));
    assert_eq!(result["visibleColors"]["pixelCount"], 3);
    assert_eq!(result["visibleColors"]["minRgb"], json!([10, 20, 30]));
    assert_eq!(result["visibleColors"]["maxRgb"], json!([30, 60, 90]));
    assert_eq!(
        result["visibleColors"]["meanRgb"],
        json!([20.0, 40.0, 60.0])
    );
    assert!(
        (result["visibleColors"]["standardDeviationRgb"][0]
            .as_f64()
            .unwrap()
            - (200.0f64 / 3.0).sqrt())
        .abs()
            < 1e-9
    );
    assert_eq!(
        result["artifact"]["sha256"],
        before["project"]["classic"]["mediaAssets"][1]["generation"]["sha256"]
    );
    assert_eq!(state(&runtime).await, before);
    assert_eq!(
        call(
            &runtime,
            "project.classic.session.status",
            json!({"projectId":"classic-project"})
        )
        .await,
        status
    );
    let mut threshold = input();
    threshold["alphaThreshold"] = json!(255);
    assert_eq!(
        call(&runtime, CAP, threshold).await["visibleColors"]["pixelCount"],
        2
    );
}

#[tokio::test]
async fn palette_rgb_and_fully_transparent_pngs_have_explicit_meaning() {
    let palette = setup(
        png_bytes(
            png::ColorType::Indexed,
            png::BitDepth::One,
            &[0b01000000, 0b10100000],
            true,
        ),
        "image/png",
        3,
        None,
    )
    .await;
    let result = call(&palette, CAP, input()).await;
    assert_eq!(result["opaquePixels"], 3);
    assert_eq!(result["transparentPixels"], 3);
    assert_eq!(result["decodedHasAlpha"], true);
    assert_eq!(result["visibleColors"]["minRgb"], json!([0, 250, 0]));
    assert_eq!(
        result["visibleColors"]["standardDeviationRgb"],
        json!([0.0, 0.0, 0.0])
    );
    let rgb = setup(
        png_bytes(png::ColorType::Rgb, png::BitDepth::Eight, &[10; 18], false),
        "image/png",
        3,
        None,
    )
    .await;
    assert_eq!(call(&rgb, CAP, input()).await["opaquePixels"], 6);
    assert_eq!(call(&rgb, CAP, input()).await["decodedHasAlpha"], false);
    let transparent = setup(
        png_bytes(png::ColorType::Rgba, png::BitDepth::Eight, &[0; 24], false),
        "image/png",
        3,
        None,
    )
    .await;
    let result = call(&transparent, CAP, input()).await;
    assert_eq!(result["transparentPixels"], 6);
    assert!(result["visibleBounds"].is_null() && result["visibleColors"].is_null());
}

#[tokio::test]
async fn foreign_stale_cancelled_unknown_or_invalid_threshold_requests_publish_no_state_change() {
    let runtime = setup(
        png_bytes(png::ColorType::Rgba, png::BitDepth::Eight, &[0; 24], false),
        "image/png",
        3,
        None,
    )
    .await;
    let before = state(&runtime).await;
    for (field, value) in [
        ("projectId", json!("foreign")),
        ("expectedRevision", json!(0)),
        ("mediaId", json!("unknown")),
        ("alphaThreshold", json!(0)),
        ("alphaThreshold", json!(256)),
        ("path", json!("C:/arbitrary.png")),
    ] {
        let mut request = input();
        request[field] = value;
        assert!(
            runtime
                .registry()
                .invoke(CAP, InvocationContext::default(), request)
                .await
                .is_err()
        );
    }
    let context = InvocationContext::default();
    context.cancellation.cancel();
    assert!(
        runtime
            .registry()
            .invoke(CAP, context, input())
            .await
            .is_err()
    );
    let mut context = InvocationContext::default();
    context
        .metadata
        .insert("opencut/projectId".into(), json!("foreign"));
    assert!(
        runtime
            .registry()
            .invoke(CAP, context, input())
            .await
            .is_err()
    );
    assert_eq!(state(&runtime).await, before);
}

#[tokio::test]
async fn corrupt_wrong_mime_checksum_dimensions_and_16_bit_images_fail_explicitly() {
    let valid = png_bytes(png::ColorType::Rgba, png::BitDepth::Eight, &[0; 24], false);
    let mut corrupt = valid.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    for (bytes, mime, width, checksum) in [
        (corrupt, "image/png", 3, None),
        (valid.clone(), "image/jpeg", 3, None),
        (valid.clone(), "image/png", 4, None),
        (valid, "image/png", 3, Some("forged")),
        (
            png_bytes(
                png::ColorType::Rgba,
                png::BitDepth::Sixteen,
                &[0; 48],
                false,
            ),
            "image/png",
            3,
            None,
        ),
    ] {
        let runtime = setup(bytes, mime, width, checksum).await;
        let before = state(&runtime).await;
        assert!(
            runtime
                .registry()
                .invoke(CAP, InvocationContext::default(), input())
                .await
                .is_err()
        );
        assert_eq!(state(&runtime).await, before);
    }
}

#[tokio::test]
async fn oversized_encoded_and_decoded_dimensions_are_rejected_before_pixel_publication() {
    let runtime = setup(vec![0; 16 * 1024 * 1024 + 1], "image/png", 3, None).await;
    assert!(
        runtime
            .registry()
            .invoke(CAP, InvocationContext::default(), input())
            .await
            .is_err()
    );
    let mut oversized = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut oversized, 4097, 2);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&vec![0; 4097 * 2 * 4])
            .unwrap();
    }
    let runtime = setup(oversized, "image/png", 4097, None).await;
    let before = state(&runtime).await;
    assert!(
        runtime
            .registry()
            .invoke(CAP, InvocationContext::default(), input())
            .await
            .is_err()
    );
    assert_eq!(state(&runtime).await, before);
}
