//! Canonical production workspace shared by the docked agent and editor UI.
use crate::{ArtifactRef, ModelError, Project};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const KEY: &str = "productionStudio";
pub const INSTRUCTIONS: &str = include_str!("production-guide.md");
pub const MAX_ROWS: usize = 500;
pub const MAX_VERSIONS: usize = 32;

/// Immutable handoff snapshot; later workspace edits intentionally do not mutate it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionHandoff {
    pub id: String,
    pub source_revision: u64,
    pub created_at: String,
    pub request: String,
    pub rows: Vec<HandoffRow>,
    pub reference_slots: Vec<HandoffReference>,
    pub reference_ids: Vec<String>,
    pub duration_ms: u32,
    pub storyboard_recommended: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoffRow {
    pub row_id: String,
    pub version: u32,
    pub content: ScriptContent,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoffReference {
    pub slot_id: String,
    pub slot_version: u32,
    pub version: u32,
    pub reference_id: String,
}
impl ProductionHandoff {
    pub fn validate(&self) -> Result<(), ModelError> {
        identifier(&self.id)?;
        timestamp(&self.created_at)?;
        text(&self.request, 6000, false)?;
        if self.rows.is_empty()
            || self.rows.len() > MAX_ROWS
            || self.reference_slots.len() > 64
            || self.reference_ids.len() > 64
            || self.duration_ms == 0
            || self.duration_ms > 86_400_000
        {
            return Err(bad("Invalid production handoff bounds"));
        }
        let mut ids = BTreeSet::new();
        let mut duration = 0;
        for row in &self.rows {
            identifier(&row.row_id)?;
            row.content.validate()?;
            duration = duration.max(row.content.end_ms);
            if !ids.insert(&row.row_id) || row.version == 0 || row.version > MAX_VERSIONS as u32 {
                return Err(bad("Invalid handoff script version"));
            }
        }
        if duration != self.duration_ms {
            return Err(bad("Handoff duration differs from script"));
        }
        let mut slots = BTreeSet::new();
        let mut refs = BTreeSet::new();
        for slot in &self.reference_slots {
            identifier(&slot.slot_id)?;
            if !slots.insert(&slot.slot_id)
                || slot.slot_version == 0
                || slot.version == 0
                || slot.version > MAX_VERSIONS as u32
                || slot.reference_id.len() != 32
                || !slot.reference_id.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(bad("Invalid handoff reference version"));
            }
            refs.insert(&slot.reference_id);
        }
        if refs != self.reference_ids.iter().collect::<BTreeSet<_>>()
            || refs.len() != self.reference_ids.len()
        {
            return Err(bad(
                "Handoff selected references differ from approved slots",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionWorkspace {
    #[serde(default)]
    pub script_rows: Vec<ScriptRow>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scripts: Vec<ScriptAsset>,
    #[serde(default)]
    pub reference_slots: Vec<ReferenceSlot>,
    #[serde(default)]
    pub analyses: Vec<VideoAnalysis>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptContent {
    pub start_ms: u32,
    pub end_ms: u32,
    pub source_language: String,
    pub source_text: String,
    #[serde(default)]
    pub latin_transliteration: String,
    #[serde(default)]
    pub speaker: String,
    #[serde(default)]
    pub visual_description: String,
    #[serde(default)]
    pub timing_estimated: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScriptVersion {
    pub version: u32,
    pub created_at: String,
    pub change_note: String,
    #[serde(flatten)]
    pub content: ScriptContent,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptRow {
    pub id: String,
    pub current_version: u32,
    pub versions: Vec<ScriptVersion>,
}
impl ScriptRow {
    pub fn current(&self) -> &ScriptVersion {
        self.versions.last().expect("validated script row")
    }
}
pub const LEGACY_SCRIPT_ID: &str = "legacy-script";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptAsset {
    pub id: String,
    pub title: String,
    pub row_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_script_id: Option<String>,
    pub versions: Vec<ScriptAssetVersion>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptAssetVersion {
    pub version: u32,
    pub title: String,
    pub rows: Vec<ScriptRowRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptRowRef {
    pub id: String,
    pub version: u32,
}

impl ScriptAsset {
    pub fn new(
        id: String,
        title: String,
        row_ids: Vec<String>,
        parent_script_id: Option<String>,
    ) -> Self {
        Self {
            id,
            title,
            row_ids,
            parent_script_id,
            versions: vec![],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ReferenceSource {
    Uploaded,
    Generated,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceVersion {
    pub version: u32,
    pub reference_id: String,
    pub caption: String,
    pub source: ReferenceSource,
    pub created_at: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceSlot {
    pub id: String,
    pub label: String,
    pub purpose: String,
    pub slot_version: u32,
    pub selected_version: Option<u32>,
    pub approved_version: Option<u32>,
    pub versions: Vec<ReferenceVersion>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeRange {
    pub start_ms: u32,
    pub end_ms: u32,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AnalysisAspect {
    Hook,
    Humor,
    Cta,
    Visuals,
    Audio,
    Pacing,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Low,
    Medium,
    High,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisObservation {
    pub aspect: AnalysisAspect,
    pub start_ms: u32,
    pub end_ms: u32,
    pub observation: String,
    pub interpretation: String,
    pub confidence: Confidence,
    pub evidence_ids: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoAnalysis {
    pub id: String,
    pub media_id: String,
    pub source_duration_ms: u32,
    pub created_at: String,
    pub title: String,
    pub reviewed_ranges: Vec<TimeRange>,
    pub observations: Vec<AnalysisObservation>,
    pub limitations: String,
    pub evidence: Vec<ArtifactRef>,
}

fn bad(message: &str) -> ModelError {
    ModelError::Invalid(message.into())
}
pub fn text(value: &str, max: usize, required: bool) -> Result<(), ModelError> {
    if (required && value.trim().is_empty()) || value.chars().count() > max || value.contains('\0')
    {
        Err(bad("Production text is empty, oversized or contains NUL"))
    } else {
        Ok(())
    }
}
pub fn identifier(value: &str) -> Result<(), ModelError> {
    if value.is_empty()
        || value.len() > 128
        || value
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || "_-".contains(c)))
    {
        Err(bad(
            "Production IDs require 1..128 letters, digits, underscore or hyphen",
        ))
    } else {
        Ok(())
    }
}
fn timestamp(value: &str) -> Result<(), ModelError> {
    if value.len() > 64 || chrono::DateTime::parse_from_rfc3339(value).is_err() {
        Err(bad("Production timestamp must be RFC3339"))
    } else {
        Ok(())
    }
}
pub fn range(start: u32, end: u32) -> Result<(), ModelError> {
    if end <= start || end > 86_400_000 {
        Err(bad(
            "Production times must be ordered milliseconds within 24 hours",
        ))
    } else {
        Ok(())
    }
}
impl ScriptContent {
    pub fn validate(&self) -> Result<(), ModelError> {
        range(self.start_ms, self.end_ms)?;
        text(&self.source_language, 32, true)?;
        if !self
            .source_language
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(bad("Use a language tag such as he, en or und"));
        }
        text(&self.source_text, 6000, false)?;
        text(&self.latin_transliteration, 6000, false)?;
        text(&self.speaker, 120, false)?;
        text(&self.visual_description, 4000, false)
    }
}
impl ProductionWorkspace {
    pub fn migrate_scripts(&mut self) {
        if self.scripts.is_empty() && !self.script_rows.is_empty() {
            self.scripts.push(ScriptAsset::new(
                LEGACY_SCRIPT_ID.into(),
                "Existing script".into(),
                self.script_rows.iter().map(|row| row.id.clone()).collect(),
                None,
            ));
            self.record_script_versions();
        }
    }

    pub fn record_script_versions(&mut self) {
        let rows: std::collections::BTreeMap<_, _> = self
            .script_rows
            .iter()
            .map(|row| (&row.id, row.current_version))
            .collect();
        for script in &mut self.scripts {
            let current = script
                .row_ids
                .iter()
                .filter_map(|id| {
                    rows.get(id).map(|version| ScriptRowRef {
                        id: id.clone(),
                        version: *version,
                    })
                })
                .collect::<Vec<_>>();
            if script
                .versions
                .last()
                .is_none_or(|v| v.title != script.title || v.rows != current)
            {
                script.versions.push(ScriptAssetVersion {
                    version: script.versions.len() as u32 + 1,
                    title: script.title.clone(),
                    rows: current,
                });
            }
        }
    }

    pub fn is_active_script_row(&self, id: &str) -> bool {
        self.scripts.is_empty()
            || self
                .scripts
                .iter()
                .any(|s| s.row_ids.iter().any(|r| r == id))
    }

    pub fn selected_script_rows(
        &self,
        script_ids: &[String],
    ) -> Result<Vec<&ScriptRow>, ModelError> {
        let selected = if script_ids.is_empty() {
            match self.scripts.as_slice() {
                [] => return Ok(self.script_rows.iter().collect()),
                [only] => vec![only],
                _ => return Err(bad("Choose which script assets to use")),
            }
        } else {
            let mut seen = BTreeSet::new();
            script_ids
                .iter()
                .map(|id| {
                    if !seen.insert(id) {
                        return Err(bad("Duplicate script selection"));
                    }
                    self.scripts
                        .iter()
                        .find(|s| &s.id == id)
                        .ok_or_else(|| bad("Script asset not found"))
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        let rows: std::collections::BTreeMap<_, _> =
            self.script_rows.iter().map(|r| (&r.id, r)).collect();
        selected
            .iter()
            .flat_map(|script| &script.row_ids)
            .map(|id| {
                rows.get(id)
                    .copied()
                    .ok_or_else(|| bad("Script row is missing"))
            })
            .collect()
    }

    pub fn validate(&self, project: &Project) -> Result<(), ModelError> {
        if self.script_rows.len() > MAX_ROWS
            || self.scripts.len() > 64
            || self.reference_slots.len() > 64
            || self.analyses.len() > 32
            || serde_json::to_vec(self)
                .map_err(|_| bad("Production serialization"))?
                .len()
                > 2 * 1024 * 1024
        {
            return Err(bad(
                "Production workspace exceeds 500 rows, 64 slots, 32 analyses or 2 MiB",
            ));
        }
        let mut ids = BTreeSet::new();
        for row in &self.script_rows {
            identifier(&row.id)?;
            if !ids.insert(&row.id)
                || row.versions.is_empty()
                || row.versions.len() > MAX_VERSIONS
                || row.current_version != row.versions.len() as u32
            {
                return Err(bad("Invalid production row version history"));
            }
            for (i, v) in row.versions.iter().enumerate() {
                if v.version != (i + 1) as u32 {
                    return Err(bad("Script revisions must be ordered and immutable"));
                }
                v.content.validate()?;
                timestamp(&v.created_at)?;
                text(&v.change_note, 500, false)?;
            }
        }
        let rows: std::collections::BTreeMap<_, _> =
            self.script_rows.iter().map(|r| (&r.id, r)).collect();
        let mut script_ids = BTreeSet::new();
        let mut ownership = std::collections::BTreeMap::new();
        for script in &self.scripts {
            identifier(&script.id)?;
            text(&script.title, 160, true)?;
            if !script_ids.insert(&script.id)
                || script.versions.is_empty()
                || script.versions.len() > 256
                || script.parent_script_id.as_ref().is_some_and(|parent| {
                    parent == &script.id
                        || !self
                            .scripts
                            .iter()
                            .any(|source| &source.id == parent && source.parent_script_id.is_none())
                })
            {
                return Err(bad("Invalid script asset or version history"));
            }
            if script.parent_script_id.is_some() {
                let anchor = script.versions[0]
                    .rows
                    .first()
                    .and_then(|reference| {
                        rows.get(&reference.id)?
                            .versions
                            .get(reference.version.checked_sub(1)? as usize)
                    })
                    .ok_or_else(|| bad("Script segment is missing its original time window"))?;
                if anchor.content.end_ms - anchor.content.start_ms > 30_000
                    || script.row_ids.iter().any(|id| {
                        rows.get(id).is_none_or(|row| {
                            let current = &row.current().content;
                            current.start_ms < anchor.content.start_ms
                                || current.end_ms > anchor.content.end_ms
                        })
                    })
                {
                    return Err(bad(
                        "Segment edits must stay inside the original 30-second window",
                    ));
                }
            }
            let latest = script.versions.last().unwrap();
            if latest.title != script.title
                || latest.rows.iter().map(|r| &r.id).ne(script.row_ids.iter())
            {
                return Err(bad("Current script differs from its saved version"));
            }
            for (i, version) in script.versions.iter().enumerate() {
                text(&version.title, 160, true)?;
                let mut unique = BTreeSet::new();
                if version.version != i as u32 + 1
                    || version.rows.iter().any(|reference| {
                        !unique.insert(&reference.id)
                            || ownership
                                .insert(&reference.id, &script.id)
                                .is_some_and(|owner| owner != &script.id)
                            || rows.get(&reference.id).is_none_or(|row| {
                                reference.version == 0
                                    || reference.version > row.current_version
                                    || (i + 1 == script.versions.len()
                                        && reference.version != row.current_version)
                            })
                    })
                {
                    return Err(bad("Invalid script version row binding"));
                }
            }
        }
        if !self.scripts.is_empty() && ownership.len() != rows.len() {
            return Err(bad(
                "Every script row must belong to exactly one script asset",
            ));
        }
        let references: crate::generative::GenerativeDocument = serde_json::from_value(
            project
                .extensions
                .get(crate::generative::KEY)
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        )
        .map_err(|_| bad("Invalid canonical references"))?;
        ids.clear();
        for slot in &self.reference_slots {
            identifier(&slot.id)?;
            text(&slot.label, 160, true)?;
            text(&slot.purpose, 2000, false)?;
            if !ids.insert(&slot.id)
                || slot.slot_version == 0
                || slot.versions.len() > MAX_VERSIONS
                || slot
                    .selected_version
                    .is_some_and(|v| v == 0 || v as usize > slot.versions.len())
                || slot
                    .approved_version
                    .is_some_and(|v| Some(v) != slot.selected_version)
                || (!slot.versions.is_empty() && slot.selected_version.is_none())
            {
                return Err(bad(
                    "Invalid reference selection, approval or version history",
                ));
            }
            for (i, v) in slot.versions.iter().enumerate() {
                if v.version != (i + 1) as u32
                    || !references.references.iter().any(|r| {
                        r.id == v.reference_id && r.kind == crate::generative::ReferenceKind::Image
                    })
                {
                    return Err(bad(
                        "Reference versions require existing canonical image references",
                    ));
                }
                timestamp(&v.created_at)?;
                text(&v.caption, 2000, false)?;
            }
        }
        ids.clear();
        for report in &self.analyses {
            identifier(&report.id)?;
            if !ids.insert(&report.id) {
                return Err(bad("Duplicate analysis ID"));
            }
            text(&report.title, 200, true)?;
            text(&report.limitations, 3000, true)?;
            timestamp(&report.created_at)?;
            if report.source_duration_ms == 0
                || report.source_duration_ms > 86_400_000
                || report.reviewed_ranges.is_empty()
                || report.reviewed_ranges.len() > 64
                || report.observations.is_empty()
                || report.observations.len() > 64
                || report.evidence.is_empty()
                || report.evidence.len() > 32
            {
                return Err(bad(
                    "Analysis requires bounded observed ranges, observations and artifact evidence",
                ));
            }
            if !project.classic.as_ref().is_some_and(|c| {
                c.media_assets
                    .iter()
                    .any(|m| m.get("id").and_then(|v| v.as_str()) == Some(&report.media_id))
            }) && !project.assets.iter().any(|a| a.id == report.media_id)
            {
                return Err(bad("Analysis source must belong to the canonical project"));
            }
            if report.evidence.iter().any(|e| {
                e.id.is_empty()
                    || e.uri != format!("opencut://artifacts/{}", e.id)
                    || e.sha256.len() != 64
                    || !e.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                    || e.byte_size == 0
            }) {
                return Err(bad("Invalid analysis artifact provenance"));
            }
            for r in &report.reviewed_ranges {
                range(r.start_ms, r.end_ms)?;
                if r.end_ms > report.source_duration_ms {
                    return Err(bad("Analysis range exceeds source duration"));
                }
            }
            for o in &report.observations {
                range(o.start_ms, o.end_ms)?;
                text(&o.observation, 2000, true)?;
                text(&o.interpretation, 2000, false)?;
                if !report
                    .reviewed_ranges
                    .iter()
                    .any(|r| r.start_ms <= o.start_ms && r.end_ms >= o.end_ms)
                    || o.evidence_ids.is_empty()
                    || o.evidence_ids.len() > 8
                    || o.evidence_ids
                        .iter()
                        .any(|id| !report.evidence.iter().any(|e| &e.id == id))
                {
                    return Err(bad(
                        "Every analysis claim needs evidence and must stay within reviewed ranges",
                    ));
                }
            }
        }
        Ok(())
    }
}

pub fn parse_script(
    text: &str,
    language: &str,
    default_duration_ms: u32,
) -> Result<Vec<ScriptContent>, ModelError> {
    self::text(text, 100_000, true)?;
    if !(250..=30_000).contains(&default_duration_ms) {
        return Err(bad(
            "Plain-script row duration must be 250..30000 milliseconds",
        ));
    }
    let normalized = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let srt = normalized.contains("-->");
    let groups: Vec<String> = if srt {
        let mut groups = Vec::new();
        let mut lines = Vec::new();
        for line in normalized.lines() {
            if line.trim().is_empty() {
                if !lines.is_empty() {
                    groups.push(lines.join("\n"));
                    lines.clear();
                }
            } else {
                lines.push(line);
            }
        }
        if !lines.is_empty() {
            groups.push(lines.join("\n"));
        }
        groups
    } else {
        normalized
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(str::to_owned)
            .collect()
    };
    if groups.is_empty() || groups.len() > MAX_ROWS {
        return Err(bad("Paste 1..500 script rows"));
    }
    let mut out = Vec::new();
    for (index, group) in groups.iter().enumerate() {
        let (start_ms, end_ms, source_text) = if srt {
            let lines: Vec<&str> = group.lines().collect();
            let line = if lines[0].contains("-->") {
                0
            } else if lines[0].trim().parse::<u32>().is_ok() {
                1
            } else {
                return Err(bad("Malformed SRT cue number or timestamp"));
            };
            let times = lines
                .get(line)
                .and_then(|l| l.split_once("-->"))
                .ok_or_else(|| bad("Malformed SRT timestamp"))?;
            let start = parse_srt_time(times.0.trim())?;
            let end = parse_srt_time(times.1.split_whitespace().next().unwrap_or(""))?;
            (start, end, lines.get(line + 1..).unwrap_or(&[]).join("\n"))
        } else {
            (
                index as u32 * default_duration_ms,
                (index as u32 + 1) * default_duration_ms,
                group.clone(),
            )
        };
        let content = ScriptContent {
            start_ms,
            end_ms,
            source_language: language.into(),
            source_text,
            latin_transliteration: String::new(),
            speaker: String::new(),
            visual_description: String::new(),
            timing_estimated: !srt,
        };
        content.validate()?;
        out.push(content);
    }
    Ok(out)
}
fn parse_srt_time(value: &str) -> Result<u32, ModelError> {
    let parts: Vec<&str> = value.split([':', ',', '.']).collect();
    if parts.len() != 4
        || parts[3].is_empty()
        || parts[3].len() > 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(bad("Use SRT timestamps HH:MM:SS,mmm"));
    }
    let nums: Vec<u32> = parts
        .iter()
        .map(|p| p.parse::<u32>().map_err(|_| bad("Invalid SRT time")))
        .collect::<Result<_, _>>()?;
    if nums[0] > 23 || nums[1] > 59 || nums[2] > 59 {
        return Err(bad("SRT time exceeds 24 hours"));
    }
    Ok(nums[0] * 3_600_000
        + nums[1] * 60_000
        + nums[2] * 1000
        + nums[3] * 10u32.pow(3 - parts[3].len() as u32))
}
