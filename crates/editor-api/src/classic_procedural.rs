//! Serializable procedural audio source. Synthesis is host IO; this module
//! validates the exact state shared by preview, export, history and agents.
use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ProceduralAudioEngine {
    Earshot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ProceduralAudioPitch {
    /// Frequency in Hz, never a playback-rate multiplier.
    Hertz(#[schemars(range(min = 20, max = 20000))] f64),
    /// Scientific note notation or a frequency string, for example A4, Fs3, 440hz.
    Note(#[schemars(length(min = 1, max = 24))] String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProceduralAudioEcho {
    #[schemars(range(min = 0.005, max = 2))]
    pub delay: f64,
    #[schemars(range(min = 0, max = 0.9))]
    pub feedback: f64,
    #[schemars(range(min = 0, max = 1))]
    pub mix: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProceduralAudioSource {
    #[schemars(range(min = 1, max = 1))]
    pub version: u8,
    pub engine: ProceduralAudioEngine,
    #[schemars(pattern("^591fa3e028032e6dce56620a20e932e35667e8d8$"))]
    pub bank_revision: String,
    #[schemars(length(min = 1, max = 128))]
    #[schemars(pattern(r"^[a-z0-9_.-]+(?:/[a-z0-9_.-]+){1,2}$"))]
    pub preset_id: String,
    pub seed: u32,
    /// Full synthesized source duration, independent of timeline trims.
    #[schemars(range(min = 0.02, max = 30))]
    pub duration: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0, max = 30))]
    pub apex: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pitch: Option<ProceduralAudioPitch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 64))]
    pub parameters: Option<BTreeMap<String, f64>>,
    /// A bounded Python source override. Never executed by the editor runtime.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 32768))]
    pub source_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub echo: Option<ProceduralAudioEcho>,
}

impl ProceduralAudioSource {
    pub fn validate(&self) -> Result<(), String> {
        classic_timeline::validate_procedural_audio_source(
            &serde_json::to_value(self).map_err(|e| e.to_string())?,
        )
    }

    pub fn source_ticks(&self) -> i64 {
        (self.duration * crate::CLASSIC_TICKS_PER_SECOND as f64).round() as i64
    }
}
