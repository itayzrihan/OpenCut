//! Immutable chapter requests and collection metadata. Provider jobs stay host-owned.
use super::GenerativeDocument;
use crate::{
    ModelError,
    production::{ProductionWorkspace, identifier, text},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRow {
    pub digest: String,
    pub id: String,
    pub version: u32,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSlot {
    pub id: String,
    pub slot_version: u32,
    pub version: u32,
    pub reference_id: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chapter {
    pub id: String,
    pub title: String,
    pub source: SourceRow,
    pub source_start_ms: u32,
    pub source_end_ms: u32,
    pub timing_estimated: bool,
    pub source_text: String,
    pub latin_transliteration: String,
    pub visual_description: String,
    pub prompt: String,
    pub duration: u32,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub direction_digest: String,
    pub id: String,
    pub title: String,
    pub version: u32,
    pub model: String,
    pub resolution: String,
    pub aspect_ratio: String,
    pub chapters: Vec<Chapter>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub programmatic: bool,
    pub references: Vec<SourceSlot>,
    #[serde(default)]
    pub batch_id: Option<String>,
    #[serde(default)]
    pub job_ids: Vec<String>,
}
fn bad(message: &str) -> ModelError {
    ModelError::Invalid(message.into())
}
impl Plan {
    pub fn validate(&self) -> Result<(), ModelError> {
        if !hex(&self.direction_digest, 64) {
            return Err(bad("Invalid chapter direction capture"));
        }
        identifier(&self.id)?;
        text(&self.title, 200, true)?;
        text(&self.model, 200, true)?;
        text(&self.resolution, 30, true)?;
        text(&self.aspect_ratio, 30, true)?;
        if self.version == 0
            || self.chapters.is_empty()
            || self.chapters.len() > 200
            || self.references.len() > 12
            || (!self.job_ids.is_empty() && self.job_ids.len() != self.chapters.len())
            || self.batch_id.is_some() != !self.job_ids.is_empty()
        {
            return Err(bad("Invalid chapter plan bounds or batch links"));
        }
        let mut ids = BTreeSet::new();
        for c in &self.chapters {
            identifier(&c.id)?;
            identifier(&c.source.id)?;
            text(&c.title, 200, true)?;
            text(&c.source_text, 20000, false)?;
            text(&c.latin_transliteration, 20000, false)?;
            text(&c.visual_description, 20000, false)?;
            text(&c.prompt, 100000, true)?;
            if !hex(&c.source.digest, 64)
                || !ids.insert(&c.id)
                || c.source.version == 0
                || !(1..=120).contains(&c.duration)
                || c.source_end_ms <= c.source_start_ms
                || c.source_end_ms > 86_400_000
                || c.source_end_ms - c.source_start_ms > c.duration * 1000
            {
                return Err(bad("Invalid chapter duration or identity"));
            }
        }
        ids.clear();
        for s in &self.references {
            identifier(&s.id)?;
            if !ids.insert(&s.id)
                || s.slot_version == 0
                || s.version == 0
                || !hex(&s.reference_id, 32)
            {
                return Err(bad("Invalid approved reference capture"));
            }
        }
        if self.batch_id.as_ref().is_some_and(|s| !hex(s, 32))
            || self.job_ids.iter().any(|s| !hex(s, 32))
            || self.job_ids.iter().collect::<BTreeSet<_>>().len() != self.job_ids.len()
        {
            return Err(bad("Invalid chapter provider links"));
        }
        Ok(())
    }
    pub fn check_sources(
        &self,
        workspace: &ProductionWorkspace,
        document: &GenerativeDocument,
    ) -> Result<(), ModelError> {
        use sha2::{Digest, Sha256};
        if self.direction_digest != format!("{:x}", Sha256::digest(document.direction.as_bytes())) {
            return Err(bad("Director direction changed; rebuild the chapter plan"));
        }
        for c in &self.chapters {
            let row = workspace
                .script_rows
                .iter()
                .find(|r| r.id == c.source.id && workspace.is_active_script_row(&r.id))
                .ok_or_else(|| bad("Chapter source row was removed; rebuild the plan"))?;
            if row.current_version != c.source.version
                || format!(
                    "{:x}",
                    Sha256::digest(
                        serde_json::to_vec(&row.current().content)
                            .map_err(|_| bad("Invalid source content"))?
                    )
                ) != c.source.digest
            {
                return Err(bad("Chapter source changed; rebuild the plan"));
            }
        }
        for s in &self.references {
            let slot = workspace
                .reference_slots
                .iter()
                .find(|r| r.id == s.id)
                .ok_or_else(|| bad("Reference slot was removed; rebuild the plan"))?;
            if slot.slot_version != s.slot_version
                || slot.approved_version != Some(s.version)
                || slot.selected_version != Some(s.version)
                || !slot
                    .versions
                    .iter()
                    .any(|v| v.version == s.version && v.reference_id == s.reference_id)
                || !document.references.iter().any(|r| r.id == s.reference_id)
            {
                return Err(bad("Approved references changed; rebuild the plan"));
            }
        }
        Ok(())
    }
}
fn hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchLink {
    pub id: String,
    pub plan_id: String,
    pub version: u32,
    pub job_ids: Vec<String>,
}

/// Preserve every original byte while assigning whole words to estimated time windows.
/// No transcript, pronunciation or alignment is inferred as verified evidence.
pub fn split_text(text: &str, windows: &[(u32, u32)], start: u32, end: u32) -> Vec<String> {
    let boundaries = std::iter::once(0)
        .chain(
            text.char_indices()
                .filter_map(|(index, ch)| ch.is_whitespace().then_some(index + ch.len_utf8())),
        )
        .chain(std::iter::once(text.len()))
        .collect::<Vec<_>>();
    let mut cursor = 0;
    windows
        .iter()
        .enumerate()
        .map(|(index, (_, stop))| {
            let cut = if index + 1 == windows.len() {
                text.len()
            } else {
                let target = (u64::from(*stop - start) * text.len() as u64 / u64::from(end - start))
                    as usize;
                boundaries
                    .iter()
                    .copied()
                    .filter(|b| *b >= cursor)
                    .min_by_key(|b| b.abs_diff(target))
                    .unwrap_or(text.len())
            };
            let piece = text[cursor..cut].to_owned();
            cursor = cut;
            piece
        })
        .collect()
}
