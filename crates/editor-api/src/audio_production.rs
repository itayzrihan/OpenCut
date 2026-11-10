//! Canonical ElevenLabs creative drafts. Credentials and paid approval never enter a document.
use crate::ModelError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const KEY: &str = "audioProduction";
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioProduction {
    #[serde(default)]
    pub drafts: Vec<AudioDraft>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueLine {
    pub text: String,
    pub voice_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AudioKind {
    Speech,
    Dialogue,
    Sound,
    Music,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioDraft {
    pub id: String,
    pub version: u64,
    pub title: String,
    pub kind: AudioKind,
    pub model_id: String,
    pub text: String,
    #[serde(default)]
    pub voice_id: Option<String>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub instrumental: bool,
    #[serde(default)]
    pub dialogue: Vec<DialogueLine>,
}
fn valid_string(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.contains('\0')
}
impl AudioDraft {
    pub fn validate(&self) -> Result<(), ModelError> {
        let bad = || {
            ModelError::Invalid(
                "Invalid audio draft: check ID, model, voice, text and duration".into(),
            )
        };
        if !valid_string(&self.id, 128)
            || self.version == 0
            || !valid_string(&self.title, 300)
            || !valid_string(&self.model_id, 120)
            || self.text.len() > 12000
            || self.text.contains('\0')
            || self.dialogue.len() > 50
        {
            return Err(bad());
        }
        if let Some(d) = self.duration_seconds {
            let (min, max) = if self.kind == AudioKind::Sound {
                (0.5, 30.)
            } else {
                (3., 600.)
            };
            if !d.is_finite() || d < min || d > max {
                return Err(bad());
            }
        }
        if let Some(v) = &self.voice_id {
            if !valid_string(v, 128)
                || !v
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err(bad());
            }
        }
        match self.kind {
            AudioKind::Speech => {
                if self.voice_id.is_none() || !valid_string(&self.text, 10000) {
                    return Err(bad());
                }
            }
            AudioKind::Dialogue => {
                if self.dialogue.is_empty()
                    || self
                        .dialogue
                        .iter()
                        .map(|l| l.text.chars().count())
                        .sum::<usize>()
                        > 2000
                {
                    return Err(bad());
                }
                let mut voices = std::collections::HashSet::new();
                for l in &self.dialogue {
                    if !valid_string(&l.text, 4000)
                        || !valid_string(&l.voice_id, 128)
                        || !l
                            .voice_id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    {
                        return Err(bad());
                    }
                    voices.insert(&l.voice_id);
                }
                if voices.len() > 10 {
                    return Err(bad());
                }
            }
            AudioKind::Sound => {
                if !valid_string(&self.text, 3000) {
                    return Err(bad());
                }
            }
            AudioKind::Music => {
                if !valid_string(&self.text, 4100) {
                    return Err(bad());
                }
            }
        }
        Ok(())
    }
}
impl AudioProduction {
    pub fn validate(&self) -> Result<(), ModelError> {
        if self.drafts.len() > 40 {
            return Err(ModelError::Invalid(
                "At most 40 audio drafts per project".into(),
            ));
        }
        let mut ids = std::collections::HashSet::new();
        for d in &self.drafts {
            d.validate()?;
            if !ids.insert(&d.id) {
                return Err(ModelError::Invalid("Duplicate audio draft".into()));
            }
        }
        if serde_json::to_vec(self)
            .map_err(|e| ModelError::Invalid(e.to_string()))?
            .len()
            > 512_000
        {
            return Err(ModelError::Invalid("Audio drafts exceed 500 KiB".into()));
        }
        Ok(())
    }
}
