//! Bounded source-PNG inspection in the canonical runtime. No filesystem IO,
//! provider calls or image mutation. Decoded color statistics are evidence,
//! not a judgment of prompt fidelity or composited timeline appearance.
use super::*;
use std::io::Cursor;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    media_id: String,
    #[serde(default = "threshold")]
    #[schemars(range(min = 1, max = 255))]
    alpha_threshold: u8,
}
fn threshold() -> u8 {
    128
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Bounds {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    center_x: f64,
    center_y: f64,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Colors {
    pixel_count: u64,
    min_rgb: [u8; 3],
    max_rgb: [u8; 3],
    mean_rgb: [f64; 3],
    standard_deviation_rgb: [f64; 3],
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    project_id: String,
    revision: u64,
    media_id: String,
    artifact: ArtifactRef,
    width: u32,
    height: u32,
    alpha_threshold: u8,
    decoded_has_alpha: bool,
    transparent_pixels: u64,
    opaque_pixels: u64,
    partial_alpha_pixels: u64,
    center_rgba: [u8; 4],
    visible_bounds: Option<Bounds>,
    visible_colors: Option<Colors>,
    interpretation: &'static str,
}
fn invalid(message: impl Into<String>) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn active(context: &InvocationContext) -> Result<(), CapabilityError> {
    if context.cancellation.is_cancelled() {
        return Err(CapabilityError::Failed("PNG inspection cancelled".into()));
    }
    Ok(())
}
fn scope(
    state: &Arc<RwLock<EditorStore>>,
    context: &InvocationContext,
    input: &Input,
) -> Result<Map<String, Value>, CapabilityError> {
    active(context)?;
    if requested_project_id(context).is_some_and(|id| id != input.project_id) {
        return Err(invalid(
            "Image inspection context belongs to another project",
        ));
    }
    let store = state.read().map_err(|_| invalid("Editor lock poisoned"))?;
    if store.document.revision != input.expected_revision {
        return Err(invalid("Image inspection revision is stale"));
    }
    let project = store
        .document
        .project
        .as_ref()
        .filter(|project| project.id == input.project_id)
        .ok_or_else(|| invalid("Image inspection target is not the active project"))?;
    let classic = project
        .classic
        .as_ref()
        .ok_or_else(|| invalid("Image inspection requires Classic media"))?;
    classic
        .media_assets
        .iter()
        .find(|asset| asset.get("id").and_then(Value::as_str) == Some(&input.media_id))
        .cloned()
        .ok_or_else(|| invalid("Image is not registered in this project"))
}
fn inspect(
    input: &Input,
    artifact: crate::StoredArtifact,
    context: &InvocationContext,
) -> Result<Output, CapabilityError> {
    if artifact.metadata.mime_type != "image/png" || artifact.bytes.len() > 16 * 1024 * 1024 {
        return Err(invalid(
            "Inspection requires a stored PNG of at most 16 MiB",
        ));
    }
    let mut decoder = png::Decoder::new_with_limits(
        Cursor::new(artifact.bytes.as_ref()),
        png::Limits {
            bytes: 64 * 1024 * 1024,
        },
    );
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder
        .read_info()
        .map_err(|e| invalid(format!("PNG header decode failed: {e}")))?;
    let info = reader.info();
    if info.width == 0
        || info.height == 0
        || info.width > 4096
        || info.height > 4096
        || info.animation_control.is_some()
        || info.bit_depth == png::BitDepth::Sixteen
    {
        return Err(invalid(
            "Inspection supports static PNGs up to 4096x4096 with 1/2/4/8-bit samples; animated and 16-bit PNGs require another inspection path",
        ));
    }
    if artifact
        .metadata
        .width
        .is_some_and(|width| width != info.width)
        || artifact
            .metadata
            .height
            .is_some_and(|height| height != info.height)
    {
        return Err(invalid(
            "PNG dimensions differ from the stored artifact metadata",
        ));
    }
    let size = reader
        .output_buffer_size()
        .filter(|size| *size <= 64 * 1024 * 1024)
        .ok_or_else(|| invalid("Decoded PNG exceeds the 64 MiB bound"))?;
    let mut decoded = vec![0; size];
    let frame = reader
        .next_frame(&mut decoded)
        .map_err(|e| invalid(format!("PNG pixel decode failed: {e}")))?;
    reader
        .finish()
        .map_err(|e| invalid(format!("PNG completion check failed: {e}")))?;
    active(context)?;
    if frame.bit_depth != png::BitDepth::Eight {
        return Err(invalid("PNG samples were not expanded to 8-bit pixels"));
    }
    let channels = match frame.color_type {
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        _ => return Err(invalid("Unsupported expanded PNG color type")),
    };
    let pixels = u64::from(frame.width) * u64::from(frame.height);
    if frame.buffer_size() != pixels as usize * channels || frame.buffer_size() > decoded.len() {
        return Err(invalid("PNG output size is inconsistent"));
    }
    let rgba = |p: &[u8]| match channels {
        1 => [p[0], p[0], p[0], 255],
        2 => [p[0], p[0], p[0], p[1]],
        3 => [p[0], p[1], p[2], 255],
        _ => [p[0], p[1], p[2], p[3]],
    };
    let mut transparent = 0;
    let mut opaque = 0;
    let mut partial = 0;
    let mut low = [frame.width, frame.height];
    let mut high = [0, 0];
    let mut count = 0u64;
    let mut min = [255u8; 3];
    let mut max = [0u8; 3];
    let mut sum = [0u64; 3];
    let mut squares = [0u64; 3];
    for (index, pixel) in decoded[..frame.buffer_size()]
        .chunks_exact(channels)
        .enumerate()
    {
        if index % 4096 == 0 {
            active(context)?;
        }
        let p = rgba(pixel);
        match p[3] {
            0 => transparent += 1,
            255 => opaque += 1,
            _ => partial += 1,
        }
        if p[3] < input.alpha_threshold {
            continue;
        }
        let x = index as u32 % frame.width;
        let y = index as u32 / frame.width;
        low[0] = low[0].min(x);
        low[1] = low[1].min(y);
        high[0] = high[0].max(x);
        high[1] = high[1].max(y);
        count += 1;
        for c in 0..3 {
            min[c] = min[c].min(p[c]);
            max[c] = max[c].max(p[c]);
            sum[c] += u64::from(p[c]);
            squares[c] += u64::from(p[c]).pow(2);
        }
    }
    let center = ((frame.height / 2 * frame.width + frame.width / 2) as usize) * channels;
    let center_rgba = rgba(&decoded[center..center + channels]);
    let visible_bounds = (count > 0).then(|| Bounds {
        x: low[0],
        y: low[1],
        width: high[0] - low[0] + 1,
        height: high[1] - low[1] + 1,
        center_x: f64::from(low[0] + high[0]) / 2.0,
        center_y: f64::from(low[1] + high[1]) / 2.0,
    });
    let visible_colors = (count > 0).then(|| {
        let mean = sum.map(|value| value as f64 / count as f64);
        Colors {
            pixel_count: count,
            min_rgb: min,
            max_rgb: max,
            mean_rgb: mean,
            standard_deviation_rgb: std::array::from_fn(|c| {
                (squares[c] as f64 / count as f64 - mean[c].powi(2))
                    .max(0.0)
                    .sqrt()
            }),
        }
    });
    Ok(Output {
        project_id: input.project_id.clone(),
        revision: input.expected_revision,
        media_id: input.media_id.clone(),
        artifact: artifact.metadata,
        width: frame.width,
        height: frame.height,
        alpha_threshold: input.alpha_threshold,
        decoded_has_alpha: matches!(
            frame.color_type,
            png::ColorType::Rgba | png::ColorType::GrayscaleAlpha
        ),
        transparent_pixels: transparent,
        opaque_pixels: opaque,
        partial_alpha_pixels: partial,
        center_rgba,
        visible_bounds,
        visible_colors,
        interpretation: "Decoded source PNG evidence. Visible bounds/colors use the stated alpha threshold and exclude hidden RGB at lower alpha. These are source pixels, not a composited timeline frame or a judgment of prompt fidelity; color management may change displayed appearance.",
    })
}
pub(super) fn register_image_inspection(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    artifacts: ArtifactStore,
) -> Result<(), RegistryError> {
    let mut descriptor = CapabilityDescriptor::read(
        "media.classic.image.inspect",
        "Inspect owned source PNG pixels",
        "Decode a PNG-backed image registered in the active Classic project and bound to its owned generation ArtifactStore record. Requires projectId, expectedRevision and mediaId. Reports exact SHA, dimensions, alpha counts, visible bounding box and unpremultiplied source RGB statistics. Optional alphaThreshold is 1..255 (default 128). PNG <=16 MiB, static <=4096x4096, expanded 8-bit pixels, decoded buffer <=64 MiB. Animated/16-bit or media without a bound PNG artifact fail explicitly. No filesystem paths, image modification or provider IO. Use this evidence to verify transparency/source geometry; use rendered frame review separately for timeline appearance.",
        "media",
        schema::<Input>(),
        schema::<Output>(),
    );
    descriptor.document_support = DocumentSupport::Classic;
    descriptor.execution = crate::CapabilityExecution::Immediate;
    descriptor.cancellable = true;
    descriptor.tags = vec![
        "image".into(),
        "png".into(),
        "alpha".into(),
        "transparency".into(),
        "colors".into(),
        "שקיפות".into(),
    ];
    registry.register(Arc::new(FnCapability::new(descriptor, move |context, value| {
        let state = state.clone(); let artifacts = artifacts.clone();
        Box::pin(async move {
            let input: Input = serde_json::from_value(value).map_err(|e| invalid(e.to_string()))?;
            let media = scope(&state, &context, &input)?;
            if media.get("type").and_then(Value::as_str) != Some("image") { return Err(invalid("Target media is not an image")); }
            let generation = media.get("generation").ok_or_else(|| invalid("Image has no bound PNG artifact; import or bind its source through an owned media adapter first"))?;
            let id = generation["artifactId"].as_str().ok_or_else(|| invalid("Image artifact ID missing"))?;
            let sha = generation["sha256"].as_str().ok_or_else(|| invalid("Image artifact checksum missing"))?;
            let artifact = artifacts.get(id).map_err(|e| invalid(e.to_string()))?;
            if artifact.metadata.sha256 != sha { return Err(invalid("Image artifact differs from its registered source checksum")); }
            let output = inspect(&input, artifact, &context)?;
            if scope(&state, &context, &input)? != media { return Err(invalid("Image binding changed during inspection")); }
            Ok(CapabilityResult::data(serde_json::to_value(output).map_err(|e| invalid(e.to_string()))?))
        })
    })))
}
