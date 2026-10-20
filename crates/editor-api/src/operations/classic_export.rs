//! Classic export policy is canonical; codec availability and rendering belong to the host.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Preferences {
    pub resolution: Resolution,
    pub encoding: Encoding,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) enum Resolution {
    Project,
    Source,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) enum Encoding {
    Compatible,
    Compact,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum Quality {
    Low,
    Medium,
    High,
    VeryHigh,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Format {
    Mp4,
    Webm,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    scene_id: String,
    preferences: Preferences,
    quality: Quality,
    format: Format,
    #[serde(default)]
    fps: Option<Rational>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Plan {
    width: u32,
    height: u32,
    logical_width: u32,
    logical_height: u32,
    codec: String,
    video_bitrate: u32,
    estimated_bytes: u64,
    upscaled_sources: Vec<String>,
    warnings: Vec<String>,
}
struct Source {
    id: String,
    name: String,
    width: f64,
    height: f64,
    duration: f64,
    video: bool,
    scale: f64,
}
fn number(v: &Value, key: &str, default: f64) -> f64 {
    v[key].as_f64().filter(|n| n.is_finite()).unwrap_or(default)
}
fn collect(
    document: &Map<String, Value>,
    assets: &[Map<String, Value>],
    scene_id: &str,
    cap: f64,
    path: &mut Vec<String>,
    sources: &mut Vec<Source>,
) {
    if path.len() >= 8 || path.iter().any(|id| id == scene_id) {
        return;
    }
    let Some(scene) = document["scenes"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["id"] == scene_id))
    else {
        return;
    };
    path.push(scene_id.into());
    let tracks = &scene["tracks"];
    let all =
        std::iter::once(&tracks["main"]).chain(tracks["overlay"].as_array().into_iter().flatten());
    for track in all.filter(|t| t["hidden"] != true) {
        for clip in track["elements"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["enabled"] != false)
        {
            let duration = number(clip, "duration", 0.0).max(0.0).min(cap);
            if duration <= 0.0 {
                continue;
            }
            if let Some(child) = clip["params"]["parallax.sceneId"].as_str() {
                collect(document, assets, child, duration, path, sources);
            }
            if clip["type"] != "video" && clip["type"] != "image" {
                continue;
            }
            let Some(asset) = assets.iter().find(|m| m.get("id") == clip.get("mediaId")) else {
                continue;
            };
            let value = Value::Object(asset.clone());
            let width = number(&value, "width", 0.0);
            let height = number(&value, "height", 0.0);
            if width <= 0.0 || height <= 0.0 {
                continue;
            }
            sources.push(Source {
                id: clip["mediaId"].as_str().unwrap_or("").into(),
                name: value["name"].as_str().unwrap_or("Media").into(),
                width,
                height,
                duration,
                video: clip["type"] == "video",
                scale: number(&clip["params"], "transform.scaleX", 1.0)
                    .abs()
                    .max(number(&clip["params"], "transform.scaleY", 1.0).abs()),
            });
        }
    }
    path.pop();
}
pub(super) fn register_export(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
) -> Result<(), RegistryError> {
    register::<Input, Plan, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "project.classic.export.plan",
        "Plan source-resolution export",
        "Read a bounded export plan for an explicit Classic scene and revision. Source resolution preserves project aspect/layout and selects the highest native resolution among video sources contributing at least10% of enabled video duration (aggregated by asset); still images, disabled clips and tiny high-resolution inserts cannot set output size. Project dimensions are never reduced; output is capped at8192. Reports upscaled sources and a target-size estimate. Compact MP4 uses HEVC; host must check support and must not silently downgrade. No IO or mutation. Preferences persist through project.classic.settings.update; Classic-only host rendering is bridged to canonical policy.",
        "project",
        AccessLevel::Read,
        true,
        false,
        &["classic", "export", "4k", "resolution", "hevc"],
        move |context, input| {
            let state = state.clone();
            async move {
                if context.cancellation.is_cancelled() {
                    return Err(CapabilityError::Failed("Cancelled".into()));
                }
                let store = state
                    .read()
                    .map_err(|_| CapabilityError::Failed("State lock poisoned".into()))?;
                if store.document.revision != input.expected_revision {
                    return Err(CapabilityError::Conflict(
                        "Export project revision changed".into(),
                    ));
                }
                let project = store
                    .document
                    .project
                    .as_ref()
                    .filter(|p| p.id == input.project_id)
                    .ok_or_else(|| CapabilityError::Conflict("Export project changed".into()))?;
                let classic = project.classic.as_ref().ok_or_else(|| {
                    CapabilityError::Unavailable("Classic project required".into())
                })?;
                let doc = &classic.document;
                let scene = doc["scenes"]
                    .as_array()
                    .and_then(|s| s.iter().find(|s| s["id"] == input.scene_id))
                    .ok_or_else(|| CapabilityError::InvalidInput("Unknown export scene".into()))?;
                let settings = scene.get("settings").unwrap_or(&doc["settings"]);
                let w = number(&settings["canvasSize"], "width", 1920.0);
                let h = number(&settings["canvasSize"], "height", 1080.0);
                if w < 2.0 || h < 2.0 || w > 8192.0 || h > 8192.0 {
                    return Err(CapabilityError::InvalidInput(
                        "Export canvas must be2..8192 pixels".into(),
                    ));
                }
                let mut sources = Vec::new();
                collect(
                    doc,
                    &classic.media_assets,
                    &input.scene_id,
                    f64::MAX,
                    &mut Vec::new(),
                    &mut sources,
                );
                let mut weights = std::collections::HashMap::<String, f64>::new();
                for s in sources.iter().filter(|s| s.video) {
                    *weights.entry(s.id.clone()).or_default() += s.duration;
                }
                let total: f64 = weights.values().sum();
                let threshold = (total * 0.1).min(weights.values().copied().fold(0.0, f64::max));
                let mut factor = 1.0_f64;
                let mut warnings = Vec::new();
                if input.preferences.resolution == Resolution::Source {
                    if total == 0.0 {
                        warnings.push(
                            "No video with known dimensions; using project resolution.".into(),
                        );
                    }
                    for s in sources
                        .iter()
                        .filter(|s| s.video && weights[&s.id] >= threshold)
                    {
                        factor = factor.max((s.width / w).min(s.height / h));
                    }
                }
                if factor * w.max(h) > 8192.0 {
                    warnings.push("Output limited to8192 pixels; choose a smaller project canvas if your encoder cannot support this size.".into());
                }
                factor = factor.min(8192.0 / w.max(h));
                let width = ((w * factor / 2.0).round() as u32).max(1) * 2;
                let height = ((h * factor / 2.0).round() as u32).max(1) * 2;
                let mut upscaled = std::collections::BTreeSet::new();
                for s in &sources {
                    let fit = (w / s.width).min(h / s.height);
                    if fit * factor * s.scale > 1.01 {
                        upscaled.insert(s.name.clone());
                    }
                }
                if !upscaled.is_empty() {
                    warnings.push("Lower-resolution or zoomed media is scaled smoothly; scaling cannot recreate missing detail.".into());
                }
                let codec = match input.format {
                    Format::Webm => "vp9",
                    Format::Mp4 if input.preferences.encoding == Encoding::Compact => "hevc",
                    _ => "avc",
                };
                let base = match (&input.quality, codec) {
                    (Quality::Low, "avc") => 2_000_000.0,
                    (Quality::Medium, "avc") => 4_000_000.0,
                    (Quality::High, "avc") => 8_000_000.0,
                    (Quality::VeryHigh, "avc") => 12_000_000.0,
                    (Quality::Low, _) => 1_500_000.0,
                    (Quality::Medium, _) => 3_000_000.0,
                    (Quality::High, _) => 6_000_000.0,
                    (Quality::VeryHigh, _) => 8_000_000.0,
                };
                let fps_value = if let Some(rate) = &input.fps {
                    rate.validate("Export fps")
                        .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                    serde_json::to_value(rate)
                        .map_err(|e| CapabilityError::Failed(e.to_string()))?
                } else {
                    settings["fps"].clone()
                };
                let fps = number(&fps_value, "numerator", 30.0)
                    / number(&fps_value, "denominator", 1.0).max(1.0);
                let bitrate = (base * width as f64 * height as f64 / (1920.0 * 1080.0)
                    * (fps / 30.0).max(1.0))
                .min(240_000_000.0)
                .round() as u32;
                let tracks = &scene["tracks"];
                let duration = std::iter::once(&tracks["main"])
                    .chain(tracks["overlay"].as_array().into_iter().flatten())
                    .chain(tracks["audio"].as_array().into_iter().flatten())
                    .flat_map(|t| t["elements"].as_array().into_iter().flatten())
                    .map(|e| number(e, "startTime", 0.0) + number(e, "duration", 0.0))
                    .fold(0.0, f64::max)
                    / 120000.0;
                Ok(OperationSuccess::new(Plan {
                    width,
                    height,
                    logical_width: w as u32,
                    logical_height: h as u32,
                    codec: codec.into(),
                    video_bitrate: bitrate,
                    estimated_bytes: ((bitrate as f64 + 320000.0) * duration / 8.0) as u64,
                    upscaled_sources: upscaled.into_iter().collect(),
                    warnings,
                }))
            }
        },
    )
}
