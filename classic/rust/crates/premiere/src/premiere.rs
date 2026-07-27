use std::collections::{HashMap, HashSet};

use bridge::export;
use serde::Deserialize;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PremiereSequenceExportOptions {
    pub sequence_name: String,
    pub fps_numerator: u32,
    pub fps_denominator: u32,
    pub width: u32,
    pub height: u32,
    pub duration_seconds: f64,
    pub video_tracks: Vec<PremiereExportTrack>,
    pub audio_tracks: Vec<PremiereExportTrack>,
    #[serde(default = "default_audio_sample_rate")]
    pub audio_sample_rate: u32,
    #[serde(default = "default_audio_depth")]
    pub audio_depth: u16,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PremiereExportTrack {
    pub name: String,
    pub clips: Vec<PremiereExportClip>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PremiereExportClip {
    pub source_id: String,
    pub name: String,
    pub path: String,
    pub source_duration_seconds: f64,
    pub timeline_start_seconds: f64,
    pub timeline_duration_seconds: f64,
    pub source_start_seconds: f64,
    #[serde(default)]
    pub source_has_audio: bool,
}

fn default_audio_sample_rate() -> u32 {
    48_000
}

fn default_audio_depth() -> u16 {
    16
}

struct XmlWriter {
    lines: Vec<String>,
    depth: usize,
}

impl XmlWriter {
    fn new() -> Self {
        Self {
            lines: Vec::new(),
            depth: 0,
        }
    }

    fn raw(&mut self, value: &str) {
        self.lines.push(value.to_owned());
    }

    fn open(&mut self, tag: &str, attributes: &[(&str, String)]) {
        self.lines.push(format!(
            "{}<{}{}>",
            "  ".repeat(self.depth),
            tag,
            attributes_string(attributes)
        ));
        self.depth += 1;
    }

    fn close(&mut self, tag: &str) {
        self.depth = self.depth.saturating_sub(1);
        self.lines
            .push(format!("{}</{}>", "  ".repeat(self.depth), tag));
    }

    fn leaf(&mut self, tag: &str, value: impl ToString) {
        self.leaf_with_attributes(tag, value, &[]);
    }

    fn leaf_with_attributes(
        &mut self,
        tag: &str,
        value: impl ToString,
        attributes: &[(&str, String)],
    ) {
        self.lines.push(format!(
            "{}<{}{}>{}</{}>",
            "  ".repeat(self.depth),
            tag,
            attributes_string(attributes),
            xml_escape(&value.to_string()),
            tag
        ));
    }

    fn finish(self) -> String {
        format!("{}\n", self.lines.join("\n"))
    }
}

fn attributes_string(attributes: &[(&str, String)]) -> String {
    attributes
        .iter()
        .map(|(name, value)| format!(" {}=\"{}\"", name, xml_escape(value)))
        .collect::<String>()
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn encode_path_component(component: &str) -> String {
    component
        .as_bytes()
        .iter()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (*byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn path_url(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let encoded = normalized
        .split('/')
        .map(|component| {
            if component.len() == 2 && component.ends_with(':') {
                component.to_owned()
            } else {
                encode_path_component(component)
            }
        })
        .collect::<Vec<_>>()
        .join("/")
        .trim_start_matches('/')
        .to_owned();

    if normalized.starts_with('/') {
        format!("file:///{encoded}")
    } else {
        format!("file://localhost/{encoded}")
    }
}

fn safe_number(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn frames(seconds: f64, fps: f64) -> i64 {
    (safe_number(seconds) * fps).round() as i64
}

fn add_rate(writer: &mut XmlWriter, timebase: u32, is_ntsc: bool) {
    writer.open("rate", &[]);
    writer.leaf("timebase", timebase);
    writer.leaf("ntsc", if is_ntsc { "TRUE" } else { "FALSE" });
    writer.close("rate");
}

fn add_file(
    writer: &mut XmlWriter,
    clip: &PremiereExportClip,
    file_id: &str,
    file_defined: &mut HashSet<String>,
    fps: f64,
    timebase: u32,
    is_ntsc: bool,
    video: bool,
    width: u32,
    height: u32,
    audio_sample_rate: u32,
    audio_depth: u16,
) {
    if file_defined.insert(clip.source_id.clone()) {
        writer.open("file", &[("id", file_id.to_owned())]);
        writer.leaf("name", &clip.name);
        writer.leaf("duration", frames(clip.source_duration_seconds, fps));
        add_rate(writer, timebase, is_ntsc);
        writer.leaf("pathurl", path_url(&clip.path));
        writer.open("media", &[]);
        if video {
            writer.open("video", &[]);
            writer.open("samplecharacteristics", &[]);
            add_rate(writer, timebase, is_ntsc);
            writer.leaf("width", width);
            writer.leaf("height", height);
            writer.leaf("anamorphic", "FALSE");
            writer.leaf("pixelaspectratio", "square");
            writer.leaf("fielddominance", "none");
            writer.leaf("alphatype", "none");
            writer.close("samplecharacteristics");
            writer.close("video");
        }
        if !video || clip.source_has_audio {
            writer.open("audio", &[]);
            writer.open("samplecharacteristics", &[]);
            writer.leaf("depth", audio_depth);
            writer.leaf("samplerate", audio_sample_rate);
            writer.close("samplecharacteristics");
            writer.close("audio");
        }
        writer.close("media");
        writer.close("file");
    } else {
        writer.leaf_with_attributes("file", "", &[("id", file_id.to_owned())]);
    }
}

fn source_ids(options: &PremiereSequenceExportOptions) -> HashMap<String, usize> {
    let mut ids = HashMap::new();
    for track in options.video_tracks.iter().chain(&options.audio_tracks) {
        for clip in &track.clips {
            let next_id = ids.len() + 1;
            ids.entry(clip.source_id.clone()).or_insert(next_id);
        }
    }
    ids
}

#[export]
pub fn generate_premiere_xml(options: PremiereSequenceExportOptions) -> String {
    let fps_denominator = options.fps_denominator.max(1);
    let fps_numerator = options.fps_numerator.max(1);
    let fps = fps_numerator as f64 / fps_denominator as f64;
    let timebase = fps.round().max(1.0) as u32;
    let is_ntsc = fps_denominator != 1;
    let total_frames = frames(options.duration_seconds, fps);
    let source_ids = source_ids(&options);
    let mut file_defined = HashSet::new();
    let mut writer = XmlWriter::new();

    writer.raw("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    writer.raw("<!DOCTYPE xmeml>");
    writer.open("xmeml", &[("version", "4".to_owned())]);
    writer.open(
        "sequence",
        &[("id", "sequence-pocut-premiere-export".to_owned())],
    );
    writer.leaf("name", options.sequence_name.trim());
    writer.leaf("duration", total_frames);
    add_rate(&mut writer, timebase, is_ntsc);
    writer.open("timecode", &[]);
    add_rate(&mut writer, timebase, is_ntsc);
    writer.leaf("string", "00:00:00:00");
    writer.leaf("frame", 0);
    writer.leaf("displayformat", "NDF");
    writer.close("timecode");
    writer.open("media", &[]);

    writer.open("video", &[]);
    writer.open("format", &[]);
    writer.open("samplecharacteristics", &[]);
    add_rate(&mut writer, timebase, is_ntsc);
    writer.leaf("width", options.width.max(1));
    writer.leaf("height", options.height.max(1));
    writer.leaf("anamorphic", "FALSE");
    writer.leaf("pixelaspectratio", "square");
    writer.leaf("fielddominance", "none");
    writer.close("samplecharacteristics");
    writer.close("format");

    let mut video_clip_index = 0_usize;
    for (track_index, track) in options.video_tracks.iter().enumerate() {
        writer.open("track", &[]);
        writer.leaf("name", &track.name);
        writer.leaf("locked", "FALSE");
        writer.leaf("enabled", "TRUE");
        for clip in &track.clips {
            if clip.path.trim().is_empty() || !(clip.timeline_duration_seconds > 0.0) {
                continue;
            }
            video_clip_index += 1;
            let clip_id = format!("clipitem-v-{video_clip_index}");
            let source_number = source_ids.get(&clip.source_id).copied().unwrap_or(0);
            let file_id = format!("file-source-{source_number}");
            let timeline_start = frames(clip.timeline_start_seconds, fps);
            let timeline_end = frames(
                clip.timeline_start_seconds + clip.timeline_duration_seconds,
                fps,
            );
            let source_start = frames(clip.source_start_seconds, fps);
            let source_end = frames(
                clip.source_start_seconds + clip.timeline_duration_seconds,
                fps,
            );

            writer.open("clipitem", &[("id", clip_id.clone())]);
            writer.leaf("masterclipid", format!("masterclip-{source_number}"));
            writer.leaf("name", &clip.name);
            writer.leaf("enabled", "TRUE");
            writer.leaf("duration", frames(clip.source_duration_seconds, fps));
            add_rate(&mut writer, timebase, is_ntsc);
            writer.leaf("start", timeline_start);
            writer.leaf("end", timeline_end);
            writer.leaf("in", source_start);
            writer.leaf("out", source_end);
            add_file(
                &mut writer,
                clip,
                &file_id,
                &mut file_defined,
                fps,
                timebase,
                is_ntsc,
                true,
                options.width.max(1),
                options.height.max(1),
                options.audio_sample_rate,
                options.audio_depth,
            );
            writer.open("link", &[]);
            writer.leaf("linkclipref", &clip_id);
            writer.leaf("mediatype", "video");
            writer.leaf("trackindex", track_index + 1);
            writer.leaf("clipindex", video_clip_index);
            writer.close("link");
            writer.close("clipitem");
        }
        writer.close("track");
    }
    writer.close("video");

    let output_channels = options.audio_tracks.len().max(2);
    writer.open("audio", &[]);
    writer.leaf("numOutputChannels", output_channels);
    writer.open("format", &[]);
    writer.open("samplecharacteristics", &[]);
    add_rate(&mut writer, timebase, is_ntsc);
    writer.leaf("depth", options.audio_depth);
    writer.leaf("samplerate", options.audio_sample_rate);
    writer.close("samplecharacteristics");
    writer.close("format");
    writer.open("outputs", &[]);
    writer.open("group", &[]);
    writer.leaf("index", 1);
    writer.leaf("numchannels", output_channels);
    writer.leaf("downmix", 0);
    for channel in 1..=output_channels {
        writer.open("channel", &[]);
        writer.leaf("index", channel);
        writer.close("channel");
    }
    writer.close("group");
    writer.close("outputs");

    let mut audio_clip_index = 0_usize;
    for (track_index, track) in options.audio_tracks.iter().enumerate() {
        writer.open("track", &[("premiereTrackType", "Mono".to_owned())]);
        writer.leaf("name", &track.name);
        writer.leaf("locked", "FALSE");
        writer.leaf("enabled", "TRUE");
        writer.leaf("outputchannelindex", track_index + 1);
        for clip in &track.clips {
            if clip.path.trim().is_empty() || !(clip.timeline_duration_seconds > 0.0) {
                continue;
            }
            audio_clip_index += 1;
            let clip_id = format!("clipitem-a-{audio_clip_index}");
            let source_number = source_ids.get(&clip.source_id).copied().unwrap_or(0);
            let file_id = format!("file-source-{source_number}");
            let timeline_start = frames(clip.timeline_start_seconds, fps);
            let timeline_end = frames(
                clip.timeline_start_seconds + clip.timeline_duration_seconds,
                fps,
            );
            let source_start = frames(clip.source_start_seconds, fps);
            let source_end = frames(
                clip.source_start_seconds + clip.timeline_duration_seconds,
                fps,
            );

            writer.open("clipitem", &[("id", clip_id)]);
            writer.leaf("masterclipid", format!("masterclip-audio-{source_number}"));
            writer.leaf("name", &clip.name);
            writer.leaf("enabled", "TRUE");
            writer.leaf("duration", frames(clip.source_duration_seconds, fps));
            add_rate(&mut writer, timebase, is_ntsc);
            writer.leaf("start", timeline_start);
            writer.leaf("end", timeline_end);
            writer.leaf("in", source_start);
            writer.leaf("out", source_end);
            add_file(
                &mut writer,
                clip,
                &file_id,
                &mut file_defined,
                fps,
                timebase,
                is_ntsc,
                false,
                options.width.max(1),
                options.height.max(1),
                options.audio_sample_rate,
                options.audio_depth,
            );
            writer.open("sourcetrack", &[]);
            writer.leaf("mediatype", "audio");
            writer.leaf("trackindex", 1);
            writer.close("sourcetrack");
            writer.close("clipitem");
        }
        writer.close("track");
    }
    writer.close("audio");
    writer.close("media");
    writer.close("sequence");
    writer.close("xmeml");
    writer.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(source_id: &str, name: &str, path: &str) -> PremiereExportClip {
        PremiereExportClip {
            source_id: source_id.to_owned(),
            name: name.to_owned(),
            path: path.to_owned(),
            source_duration_seconds: 120.0,
            timeline_start_seconds: 10.0,
            timeline_duration_seconds: 5.0,
            source_start_seconds: 20.0,
            source_has_audio: true,
        }
    }

    #[test]
    fn exports_premiere_xmeml_with_absolute_timing_and_encoded_paths() {
        let xml = generate_premiere_xml(PremiereSequenceExportOptions {
            sequence_name: "Podcast & Guests".to_owned(),
            fps_numerator: 30,
            fps_denominator: 1,
            width: 1920,
            height: 1080,
            duration_seconds: 60.0,
            video_tracks: vec![PremiereExportTrack {
                name: "Camera 1".to_owned(),
                clips: vec![clip(
                    "video-1",
                    "ירין Camera.MP4",
                    "/Volumes/Portable Sandisk SSD/לקוחות/ירין Camera.MP4",
                )],
            }],
            audio_tracks: vec![PremiereExportTrack {
                name: "Mic 1".to_owned(),
                clips: vec![clip(
                    "audio-1",
                    "Mic.wav",
                    "/Volumes/Portable Sandisk SSD/Mic.wav",
                )],
            }],
            audio_sample_rate: 48_000,
            audio_depth: 16,
        });

        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE xmeml>"));
        assert!(xml.contains("<name>Podcast &amp; Guests</name>"));
        assert!(xml.contains("<start>300</start>"));
        assert!(xml.contains("<end>450</end>"));
        assert!(xml.contains("<in>600</in>"));
        assert!(xml.contains("<out>750</out>"));
        assert!(xml.contains("file:///Volumes/Portable%20Sandisk%20SSD/%D7%9C%D7%A7%D7%95%D7%97%D7%95%D7%AA/%D7%99%D7%A8%D7%99%D7%9F%20Camera.MP4"));
    }

    #[test]
    fn marks_fractional_frame_rates_as_ntsc() {
        let xml = generate_premiere_xml(PremiereSequenceExportOptions {
            sequence_name: "NTSC".to_owned(),
            fps_numerator: 30_000,
            fps_denominator: 1_001,
            width: 1920,
            height: 1080,
            duration_seconds: 1.0,
            video_tracks: Vec::new(),
            audio_tracks: Vec::new(),
            audio_sample_rate: 48_000,
            audio_depth: 16,
        });

        assert!(xml.contains("<timebase>30</timebase>"));
        assert!(xml.contains("<ntsc>TRUE</ntsc>"));
        assert!(xml.contains("<duration>30</duration>"));
    }
}
