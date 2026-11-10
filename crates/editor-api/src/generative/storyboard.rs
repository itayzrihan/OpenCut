//! Canonical, client-facing storyboard projection. Never exports provider prompts.
use super::{GenerativeDocument, Reference, ReferenceKind};
use crate::ModelError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Storyboard {
    #[schemars(length(min = 1, max = 200))]
    pub title: String,
    #[serde(default)]
    #[schemars(length(max = 6000))]
    pub summary: String,
    /// Empty means include the project's existing storyboard sheets.
    #[serde(default)]
    #[schemars(length(max = 8))]
    pub sheet_reference_ids: Vec<String>,
    #[schemars(length(max = 96))]
    pub scenes: Vec<Scene>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scene {
    #[schemars(length(min = 1, max = 120))]
    pub id: String,
    #[schemars(length(min = 1, max = 200))]
    pub title: String,
    #[schemars(length(min = 1, max = 6000))]
    pub description: String,
    #[serde(default)]
    pub start_seconds: Option<f64>,
    #[serde(default)]
    pub end_seconds: Option<f64>,
    /// Explicit image reference only; never guesses a crop from a sheet.
    #[serde(default)]
    pub image_reference_id: Option<String>,
}

fn invalid() -> ModelError {
    ModelError::Invalid("Storyboard requires bounded client-facing copy, ordered timing and owned image references".into())
}
fn bounded(text: &str, max: usize, required: bool) -> bool {
    (!required || !text.trim().is_empty()) && text.chars().count() <= max
}
impl Storyboard {
    pub fn validate(&self, references: &[Reference]) -> Result<(), ModelError> {
        let image = |id: &str| references.iter().any(|r| r.id == id && r.kind == ReferenceKind::Image && ["image/png", "image/jpeg", "image/webp"].contains(&r.mime.as_str()));
        if !bounded(&self.title, 200, true) || !bounded(&self.summary, 6000, false)
            || self.sheet_reference_ids.len() > 8 || self.scenes.len() > 96 {
            return Err(invalid());
        }
        let mut sheets = std::collections::BTreeSet::new();
        for id in &self.sheet_reference_ids {
            if !image(id) || !sheets.insert(id) { return Err(invalid()); }
        }
        let mut scenes = std::collections::BTreeSet::new();
        let mut copy_bytes = self.title.len() + self.summary.len();
        for s in &self.scenes {
            copy_bytes += s.id.len() + s.title.len() + s.description.len();
            if copy_bytes > 180_000 { return Err(invalid()); }
            if !bounded(&s.id, 120, true) || !scenes.insert(&s.id)
                || !bounded(&s.title, 200, true) || !bounded(&s.description, 6000, true)
                || s.image_reference_id.as_deref().is_some_and(|id| !image(id)) {
                return Err(invalid());
            }
            match (s.start_seconds, s.end_seconds) {
                (None, None) => {},
                (Some(a), Some(b)) if a.is_finite() && b.is_finite() && a >= 0.0 && b > a && b <= 86400.0 => {},
                _ => return Err(invalid()),
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub project_id: String,
    pub revision: u64,
    pub title: String,
    pub summary: String,
    pub sheets: Vec<Reference>,
    pub scenes: Vec<Scene>,
    /// The only images a host may resolve for this proposal.
    pub scene_images: Vec<Reference>,
    pub digest: String,
}

fn text(value: &serde_json::Value, key: &str, max: usize) -> String {
    value.get(key).and_then(|v| v.as_str()).unwrap_or("").chars().take(max).collect()
}
fn seconds(value: &serde_json::Value) -> Option<f64> {
    value.as_f64().or_else(|| value.as_str().and_then(|s| s.trim().trim_end_matches('s').parse().ok()))
        .filter(|v| v.is_finite() && *v >= 0.0 && *v <= 86400.0)
}

pub fn plan(document: &GenerativeDocument, project_id: &str, revision: u64, project_name: &str) -> Result<Plan, ModelError> {
    document.validate()?;
    let board = if let Some(board) = &document.storyboard { board.clone() } else {
        let raw = document.direction.trim();
        let raw = raw.strip_prefix("```json").or_else(|| raw.strip_prefix("```"))
            .and_then(|v| v.trim().strip_suffix("```" )).unwrap_or(raw).trim();
        let direction: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
        let shots = direction.get("shots").and_then(|v| v.as_array());
        if shots.is_some_and(|s| s.len() > 96) { return Err(invalid()); }
        let mut scenes = Vec::new();
        for (index, shot) in shots.into_iter().flatten().enumerate() {
            let description = text(shot, "description", 6001);
            if description.trim().is_empty() { return Err(ModelError::Invalid(format!("Shot {} needs a client-facing description before PDF export", index + 1))); }
            let title = text(shot, "title", 201);
            let timing = (shot.get("start").and_then(seconds), shot.get("end").and_then(seconds));
            let (start_seconds, end_seconds) = match timing { (Some(a),Some(b)) if b > a => (Some(a),Some(b)), _ => (None,None) };
            scenes.push(Scene { id: format!("shot-{}", index + 1), title: if title.trim().is_empty() { format!("Scene {:02}", index + 1) } else { title }, description, start_seconds, end_seconds, image_reference_id: None });
        }
        Storyboard { title: project_name.chars().take(200).collect(), summary: text(&direction, "creative_intent", 6001), sheet_reference_ids: vec![], scenes }
    };
    board.validate(&document.references)?;
    let sheets = if board.sheet_reference_ids.is_empty() {
        document.references.iter().filter(|r| r.storyboard && r.kind == ReferenceKind::Image).cloned().collect::<Vec<_>>()
    } else {
        board.sheet_reference_ids.iter().filter_map(|id| document.references.iter().find(|r| &r.id == id).cloned()).collect()
    };
    if sheets.len() > 8 { return Err(ModelError::Invalid("Choose at most eight storyboard sheets in the canonical proposal".into())); }
    if sheets.is_empty() && board.scenes.is_empty() { return Err(ModelError::Invalid("Add a storyboard sheet or planned scenes before exporting a proposal".into())); }
    if sheets.iter().any(|r| !["image/png", "image/jpeg", "image/webp"].contains(&r.mime.as_str())) { return Err(invalid()); }
    let scene_images = document.references.iter().filter(|r| board.scenes.iter().any(|s| s.image_reference_id.as_deref() == Some(&r.id))).cloned().collect();
    let mut out = Plan { project_id: project_id.into(), revision, title: board.title, summary: board.summary, sheets, scenes: board.scenes, scene_images, digest: String::new() };
    let serialized = serde_json::to_vec(&out).map_err(|_| invalid())?;
    if serialized.len() > 350_000 { return Err(invalid()); }
    out.digest = format!("{:x}", Sha256::digest(serialized));
    Ok(out)
}
