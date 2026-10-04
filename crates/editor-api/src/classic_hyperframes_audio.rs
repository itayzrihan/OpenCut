//! Read-only audio views of compound clips. These never become separate edits
//! or tracks: every read reflects the canonical Classic scene and undo history.
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::{CLASSIC_TICKS_PER_SECOND, ClassicProject, ModelError};

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClassicHyperframesAudioClip {
    pub composition_id: String,
    /// Ordinary Classic uploaded AudioElement shape, consumed by the existing
    /// playback/export mixer. Its media ID is a derived render binding only.
    pub element: Map<String, Value>,
}

impl ClassicProject {
    pub fn hyperframes_audio_clips(
        &self,
        scene_id: &str,
    ) -> Result<Vec<ClassicHyperframesAudioClip>, ModelError> {
        let scene = self
            .scenes()?
            .iter()
            .find(|scene| scene["id"] == scene_id)
            .ok_or_else(|| ModelError::Invalid("HyperFrames audio scene is missing".into()))?;
        let compositions = self.compositions()?;
        let mut clips = Vec::new();
        for track in crate::classic::tracks(scene)? {
            if track["muted"] == true {
                continue;
            }
            for element in track["elements"].as_array().into_iter().flatten() {
                if element["type"] != "graphic"
                    || element["definitionId"] != "hyperframes"
                    || element["params"]["muted"] == true
                {
                    continue;
                }
                let Some(id) = element["params"]["hyperframesAssetId"].as_str() else {
                    continue;
                };
                let composition = compositions.get(id).ok_or_else(|| {
                    ModelError::Invalid("HyperFrames audio composition is missing".into())
                })?;
                let source_duration =
                    (composition.duration_seconds * CLASSIC_TICKS_PER_SECOND as f64).round() as i64;
                let trim_start = element["trimStart"].as_i64().unwrap_or(0);
                // The visual source freezes after its end. Audio stops there;
                // AAC encoder padding must not leak past the authored window.
                let duration = element["duration"]
                    .as_i64()
                    .unwrap_or(0)
                    .min(source_duration.saturating_sub(trim_start));
                if duration <= 0 {
                    continue;
                }
                let mut audio = Map::new();
                for field in [
                    "id",
                    "name",
                    "startTime",
                    "trimStart",
                    "params",
                    "animations",
                ] {
                    if let Some(value) = element.get(field) {
                        audio.insert(field.into(), value.clone());
                    }
                }
                audio.insert("type".into(), json!("audio"));
                audio.insert("sourceType".into(), json!("upload"));
                audio.insert("mediaId".into(), json!(id));
                audio.insert("duration".into(), json!(duration));
                audio.insert("sourceDuration".into(), json!(source_duration));
                audio.insert(
                    "trimEnd".into(),
                    json!(source_duration - trim_start - duration),
                );
                // Graphic playback currently has neither retime nor looping.
                // Hidden is a visual flag; it does not mute a compound's audio.
                clips.push(ClassicHyperframesAudioClip {
                    composition_id: id.into(),
                    element: audio,
                });
            }
        }
        Ok(clips)
    }
}
