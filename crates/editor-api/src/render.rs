use std::{
    collections::BTreeMap,
    io::Read,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::{
    EditorDocument, ExportPreset, MediaAsset, MediaType, Project, TimelineItem, TimelineItemKind,
};

#[derive(Debug, Clone, Copy)]
pub(crate) enum RenderTarget {
    Video,
    Frame {
        position_seconds: f64,
        width: Option<u32>,
        height: Option<u32>,
    },
}

#[derive(Debug)]
pub(crate) struct RenderReport {
    pub command: Vec<String>,
    pub warnings: Vec<String>,
    pub stderr: String,
}

pub(crate) fn render(
    document: &EditorDocument,
    output_path: &str,
    preset_id: Option<&str>,
    target: RenderTarget,
    overwrite: bool,
    cancellation: &CancellationToken,
) -> Result<RenderReport, String> {
    let project = document
        .project
        .as_ref()
        .ok_or_else(|| "no project is open".to_owned())?;
    if Path::new(output_path).exists() && !overwrite {
        return Err(format!(
            "output `{output_path}` already exists; set overwrite to true to replace it"
        ));
    }
    if let Some(parent) = Path::new(output_path).parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let preset = preset_id
        .map(|id| {
            project
                .export_presets
                .iter()
                .find(|preset| preset.id == id)
                .ok_or_else(|| format!("unknown export preset `{id}`"))
        })
        .transpose()?;
    let plan = build_ffmpeg_plan(project, output_path, preset, target, overwrite)?;
    let executable = std::env::var("OPENCUT_FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".to_owned());
    let mut child = Command::new(&executable)
        .args(&plan.arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to launch `{executable}`: {error}"))?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture FFmpeg diagnostics".to_owned())?;
    let stderr_reader = std::thread::spawn(move || {
        let mut stderr = String::new();
        let mut pipe = stderr_pipe;
        pipe.read_to_string(&mut stderr).map(|_| stderr)
    });
    let status = loop {
        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stderr_reader.join();
            return Err("render was cancelled".into());
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stderr = stderr_reader
        .join()
        .map_err(|_| "FFmpeg diagnostic reader panicked".to_owned())?
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!(
            "FFmpeg exited with {}: {}",
            status,
            tail(&stderr, 30)
        ));
    }
    Ok(RenderReport {
        command: std::iter::once(executable).chain(plan.arguments).collect(),
        warnings: plan.warnings,
        stderr: tail(&stderr, 12),
    })
}

struct FfmpegPlan {
    arguments: Vec<String>,
    warnings: Vec<String>,
}

fn build_ffmpeg_plan(
    project: &Project,
    output_path: &str,
    preset: Option<&ExportPreset>,
    target: RenderTarget,
    overwrite: bool,
) -> Result<FfmpegPlan, String> {
    let settings = &project.settings;
    let target_dimensions = match target {
        RenderTarget::Frame { width, height, .. } => Some((width, height)),
        RenderTarget::Video => None,
    };
    let width = target_dimensions
        .and_then(|(width, _)| width)
        .or_else(|| preset.and_then(|preset| preset.width))
        .unwrap_or(settings.width);
    let height = target_dimensions
        .and_then(|(_, height)| height)
        .or_else(|| preset.and_then(|preset| preset.height))
        .unwrap_or(settings.height);
    let frame_rate = preset
        .and_then(|preset| preset.frame_rate)
        .unwrap_or(settings.frame_rate);
    let source_timeline_duration = project.timeline.duration();
    if matches!(target, RenderTarget::Video) && source_timeline_duration <= 0.0 {
        return Err("timeline is empty".into());
    }
    let timeline_duration = match target {
        RenderTarget::Frame {
            position_seconds, ..
        } => source_timeline_duration
            .max(position_seconds + (1.0 / frame_rate))
            .max(1.0 / frame_rate),
        RenderTarget::Video => source_timeline_duration,
    };
    let render_duration = match target {
        RenderTarget::Video => {
            let start = project.timeline.in_point_seconds.unwrap_or_default();
            let end = project
                .timeline
                .out_point_seconds
                .unwrap_or(timeline_duration);
            end - start
        }
        RenderTarget::Frame {
            position_seconds, ..
        } => {
            if position_seconds < 0.0
                || (source_timeline_duration > 0.0 && position_seconds > source_timeline_duration)
            {
                return Err(format!(
                    "preview position {position_seconds} is outside the timeline"
                ));
            }
            timeline_duration
        }
    };
    if render_duration <= 0.0 {
        return Err("render range has no duration".into());
    }

    let mut arguments = vec![
        if overwrite { "-y" } else { "-n" }.into(),
        "-hide_banner".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!(
            "color=c={}:s={}x{}:r={}:d={}",
            normalize_color(&settings.background_color),
            width,
            height,
            frame_rate,
            timeline_duration
        ),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!(
            "anullsrc=r={}:cl={}:d={}",
            settings.sample_rate,
            channel_layout(settings.channels),
            timeline_duration
        ),
    ];
    let assets: BTreeMap<_, _> = project
        .assets
        .iter()
        .map(|asset| (asset.id.as_str(), asset))
        .collect();
    let mut inputs = Vec::new();
    let mut next_input_index = 2usize;
    for track in &project.timeline.tracks {
        if !track.enabled || track.hidden {
            continue;
        }
        for item in &track.items {
            if !item.enabled {
                continue;
            }
            let Some(asset_id) = item.asset_id.as_deref() else {
                continue;
            };
            let referenced_asset = assets
                .get(asset_id)
                .ok_or_else(|| format!("item `{}` references missing asset", item.id))?;
            let (visual_asset, audio_asset) =
                if let Some(unified) = &referenced_asset.unified_angles {
                    let visual_id = item
                        .active_angle_asset_id
                        .as_ref()
                        .unwrap_or(&unified.default_angle_asset_id);
                    let visual = assets.get(visual_id.as_str()).ok_or_else(|| {
                        format!("Unified Angles asset `{asset_id}` is missing angle `{visual_id}`")
                    })?;
                    let audio = assets.get(unified.audio_asset_id.as_str()).ok_or_else(|| {
                        format!(
                            "Unified Angles asset `{asset_id}` is missing audio source `{}`",
                            unified.audio_asset_id
                        )
                    })?;
                    (*visual, *audio)
                } else {
                    (*referenced_asset, *referenced_asset)
                };
            if visual_asset.offline || audio_asset.offline {
                return Err(format!("asset `{}` is offline", referenced_asset.name));
            }
            let visual_index = next_input_index;
            append_input(&mut arguments, visual_asset, item);
            next_input_index += 1;
            let audio_index = if audio_asset.id == visual_asset.id {
                visual_index
            } else {
                let index = next_input_index;
                append_input(&mut arguments, audio_asset, item);
                next_input_index += 1;
                index
            };
            inputs.push((
                visual_index,
                audio_index,
                track.muted,
                item,
                visual_asset,
                audio_asset,
            ));
        }
    }

    let mut filters = vec!["[0:v]setpts=PTS-STARTPTS[base0]".to_owned()];
    let mut warnings = Vec::new();
    let mut base_index = 0usize;
    let mut audio_labels = vec!["[1:a]".to_owned()];

    for (visual_input_index, audio_input_index, track_muted, item, visual_asset, audio_asset) in
        inputs
    {
        if visual_asset.has_video && visual_kind(item.kind) {
            let visual_label = format!("visual{visual_input_index}");
            let mut chain = format!(
                "[{visual_input_index}:v]trim=duration={},setpts=(PTS-STARTPTS)/{}+{}/TB",
                item.duration_seconds * item.speed,
                item.speed,
                item.start_seconds
            );
            append_visual_filters(&mut chain, item, &mut warnings);
            chain.push_str(&format!("[{visual_label}]"));
            filters.push(chain);
            let next_base = base_index + 1;
            filters.push(format!(
                "[base{base_index}][{visual_label}]overlay=x='(W-w)/2+{}':y='(H-h)/2+{}':enable='between(t,{},{})'[base{next_base}]",
                item.transform.position_x,
                item.transform.position_y,
                item.start_seconds,
                item.end_seconds()
            ));
            base_index = next_base;
        }
        if matches!(target, RenderTarget::Video)
            && audio_asset.has_audio
            && !track_muted
            && !item.audio.muted
        {
            let label = format!("audio{audio_input_index}");
            let delay_ms = (item.start_seconds * 1000.0).round() as u64;
            let mut chain = format!(
                "[{audio_input_index}:a]atrim=duration={},asetpts=PTS-STARTPTS",
                item.duration_seconds * item.speed
            );
            append_atempo(&mut chain, item.speed);
            chain.push_str(&format!(
                ",volume={},adelay={delay_ms}:all=1[{label}]",
                item.audio.volume
            ));
            filters.push(chain);
            audio_labels.push(format!("[{label}]"));
        }
    }

    for track in &project.timeline.tracks {
        if !track.enabled || track.hidden {
            continue;
        }
        for item in &track.items {
            if !item.enabled {
                continue;
            }
            match item.kind {
                TimelineItemKind::Text | TimelineItemKind::Caption => {
                    let Some(text) = &item.text else {
                        continue;
                    };
                    let next_base = base_index + 1;
                    let x = item.transform.position_x;
                    let y = item.transform.position_y;
                    filters.push(format!(
                        "[base{base_index}]drawtext=text='{}':font='{}':fontsize={}:fontcolor={}:x='(w-text_w)/2+{x}':y='(h-text_h)/2+{y}':enable='between(t,{},{})'[base{next_base}]",
                        escape_filter_text(&text.content),
                        escape_filter_text(&text.font_family),
                        text.font_size,
                        normalize_color(&text.color),
                        item.start_seconds,
                        item.end_seconds()
                    ));
                    base_index = next_base;
                    if !text.rich_spans.is_empty() {
                        warnings.push(format!(
                            "text item `{}` uses rich spans; the current FFmpeg renderer applies its base style",
                            item.id
                        ));
                    }
                }
                TimelineItemKind::Shape => {
                    let Some(shape) = &item.shape else {
                        continue;
                    };
                    let next_base = base_index + 1;
                    let box_width = shape
                        .parameters
                        .get("width")
                        .and_then(Value::as_f64)
                        .unwrap_or(width as f64 * 0.25);
                    let box_height = shape
                        .parameters
                        .get("height")
                        .and_then(Value::as_f64)
                        .unwrap_or(height as f64 * 0.25);
                    filters.push(format!(
                        "[base{base_index}]drawbox=x='(w-{box_width})/2+{}':y='(h-{box_height})/2+{}':w={box_width}:h={box_height}:color={}@{}:t=fill:enable='between(t,{},{})'[base{next_base}]",
                        item.transform.position_x,
                        item.transform.position_y,
                        normalize_color(&shape.fill_color),
                        item.opacity,
                        item.start_seconds,
                        item.end_seconds()
                    ));
                    base_index = next_base;
                }
                TimelineItemKind::Adjustment => {
                    warnings.push(format!(
                        "adjustment item `{}` is preserved in the project but not yet rendered",
                        item.id
                    ));
                }
                _ => {}
            }
            if !item.keyframes.is_empty() {
                warnings.push(format!(
                    "item `{}` has keyframes; static values are used by this renderer",
                    item.id
                ));
            }
            if !item.masks.is_empty() {
                warnings.push(format!(
                    "item `{}` has masks; mask data is preserved but the FFmpeg compatibility renderer does not render it",
                    item.id
                ));
            }
        }
    }

    let mixed_audio = if audio_labels.len() == 1 {
        false
    } else {
        filters.push(format!(
            "{}amix=inputs={}:duration=longest:dropout_transition=0[aout]",
            audio_labels.join(""),
            audio_labels.len()
        ));
        true
    };
    if !project.timeline.transitions.is_empty() {
        warnings.push(
            "timeline transitions are preserved in the project but rendered as hard cuts".into(),
        );
    }
    if project.settings.background.fill_type != "solid" {
        warnings.push(
            "the project uses a gradient background; the FFmpeg compatibility renderer uses backgroundColor"
                .into(),
        );
    }

    arguments.extend([
        "-filter_complex".into(),
        filters.join(";"),
        "-map".into(),
        format!("[base{base_index}]"),
    ]);
    match target {
        RenderTarget::Video => {
            arguments.extend([
                "-map".into(),
                if mixed_audio {
                    "[aout]".into()
                } else {
                    "1:a".into()
                },
            ]);
            let start = project.timeline.in_point_seconds.unwrap_or_default();
            if start > 0.0 {
                arguments.extend(["-ss".into(), start.to_string()]);
            }
            arguments.extend(["-t".into(), render_duration.to_string()]);
            let preset = preset.cloned().unwrap_or_else(default_preset);
            arguments.extend(["-c:v".into(), preset.video_codec]);
            arguments.extend(["-c:a".into(), preset.audio_codec]);
            if let Some(bitrate) = preset.video_bitrate {
                arguments.extend(["-b:v".into(), bitrate.to_string()]);
            }
            if let Some(bitrate) = preset.audio_bitrate {
                arguments.extend(["-b:a".into(), bitrate.to_string()]);
            }
            for (key, value) in preset.options {
                arguments.push(format!("-{key}"));
                arguments.push(value_to_argument(value));
            }
        }
        RenderTarget::Frame {
            position_seconds, ..
        } => {
            arguments.extend([
                "-ss".into(),
                position_seconds.to_string(),
                "-frames:v".into(),
                "1".into(),
                "-an".into(),
            ]);
        }
    }
    arguments.push(output_path.into());
    Ok(FfmpegPlan {
        arguments,
        warnings,
    })
}

fn append_input(arguments: &mut Vec<String>, asset: &MediaAsset, item: &TimelineItem) {
    if matches!(asset.media_type, MediaType::Image) {
        arguments.extend(["-loop".into(), "1".into()]);
    }
    arguments.extend(["-ss".into(), item.source_in_seconds.to_string()]);
    arguments.extend([
        "-t".into(),
        (item.duration_seconds * item.speed).to_string(),
        "-i".into(),
        asset.source.clone(),
    ]);
}

fn append_visual_filters(chain: &mut String, item: &TimelineItem, warnings: &mut Vec<String>) {
    let crop = &item.transform.crop;
    if crop.left > 0.0 || crop.top > 0.0 || crop.right > 0.0 || crop.bottom > 0.0 {
        chain.push_str(&format!(
            ",crop=iw*{}:ih*{}:iw*{}:ih*{}",
            1.0 - crop.left - crop.right,
            1.0 - crop.top - crop.bottom,
            crop.left,
            crop.top
        ));
    }
    chain.push_str(&format!(
        ",scale='iw*{}':'ih*{}'",
        item.transform.scale_x.abs(),
        item.transform.scale_y.abs()
    ));
    if item.transform.rotation_degrees != 0.0 {
        chain.push_str(&format!(
            ",rotate={}/180*PI:ow=rotw(iw):oh=roth(ih):c=none",
            item.transform.rotation_degrees
        ));
    }
    for effect in &item.effects {
        if !effect.enabled {
            continue;
        }
        match effect.effect_type.as_str() {
            "color" | "color-correction" | "eq" => {
                let brightness = number(&effect.parameters, "brightness", 0.0);
                let contrast = number(&effect.parameters, "contrast", 1.0);
                let saturation = number(&effect.parameters, "saturation", 1.0);
                chain.push_str(&format!(
                    ",eq=brightness={brightness}:contrast={contrast}:saturation={saturation}"
                ));
            }
            "blur" | "gaussian-blur" => {
                let sigma = number(&effect.parameters, "sigma", 3.0);
                chain.push_str(&format!(",gblur=sigma={sigma}"));
            }
            "hue" => {
                let degrees = number(&effect.parameters, "degrees", 0.0);
                chain.push_str(&format!(",hue=h={degrees}"));
            }
            other => warnings.push(format!(
                "effect `{}` ({other}) is preserved but unsupported by the FFmpeg renderer",
                effect.name
            )),
        }
    }
    chain.push_str(&format!(
        ",format=rgba,colorchannelmixer=aa={}",
        item.opacity
    ));
}

fn append_atempo(chain: &mut String, mut speed: f64) {
    while speed > 2.0 {
        chain.push_str(",atempo=2.0");
        speed /= 2.0;
    }
    while speed < 0.5 {
        chain.push_str(",atempo=0.5");
        speed /= 0.5;
    }
    chain.push_str(&format!(",atempo={speed}"));
}

fn visual_kind(kind: TimelineItemKind) -> bool {
    matches!(
        kind,
        TimelineItemKind::Video
            | TimelineItemKind::Image
            | TimelineItemKind::Compound
            | TimelineItemKind::Adjustment
    )
}

fn number(parameters: &serde_json::Map<String, Value>, key: &str, fallback: f64) -> f64 {
    parameters
        .get(key)
        .and_then(Value::as_f64)
        .unwrap_or(fallback)
}

fn normalize_color(value: &str) -> String {
    value.strip_prefix('#').unwrap_or(value).to_owned()
}

fn escape_filter_text(value: &str) -> String {
    value
        .replace('\\', r"\\")
        .replace('\'', r"\'")
        .replace(':', r"\:")
        .replace('%', r"\%")
        .replace('\n', r"\n")
}

fn channel_layout(channels: u8) -> &'static str {
    match channels {
        1 => "mono",
        _ => "stereo",
    }
}

fn value_to_argument(value: Value) -> String {
    match value {
        Value::String(value) => value,
        other => other.to_string(),
    }
}

fn default_preset() -> ExportPreset {
    ExportPreset {
        id: "default".into(),
        name: "Default".into(),
        container: "mp4".into(),
        video_codec: "libx264".into(),
        audio_codec: "aac".into(),
        width: None,
        height: None,
        frame_rate: None,
        video_bitrate: Some(12_000_000),
        audio_bitrate: Some(192_000),
        options: serde_json::Map::new(),
    }
}

fn tail(value: &str, count: usize) -> String {
    let lines: Vec<_> = value.lines().collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}
