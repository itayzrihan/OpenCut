//! Project planning notes are part of the canonical Classic document and history.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub const MAX_NOTES: usize = 200;
pub const MAX_NOTE_BODY: usize = 20_000;
pub const MAX_NOTES_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectNote {
    pub id: String,
    pub title: String,
    pub body: String,
    pub version: u64,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn text(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.chars().count() > max || value.contains('\0') {
        return Err(format!(
            "{label} exceeds its limit or contains a NUL character"
        ));
    }
    Ok(())
}

pub(crate) fn identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(format!("{label} must be a bounded non-empty identifier"));
    }
    Ok(())
}

pub(crate) fn timestamp(value: &str) -> Result<chrono::DateTime<chrono::FixedOffset>, String> {
    if value.len() > 64 {
        return Err("Timestamp is too long".into());
    }
    chrono::DateTime::parse_from_rfc3339(value).map_err(|_| "Timestamp must be RFC 3339".into())
}

pub(crate) fn read(value: Option<&Value>) -> Result<Vec<ProjectNote>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > MAX_NOTES_BYTES {
        return Err("Project notes exceed the one MiB document budget".into());
    }
    let notes: Vec<ProjectNote> =
        serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    validate(&notes)?;
    Ok(notes)
}

pub(crate) fn validate(notes: &[ProjectNote]) -> Result<(), String> {
    if notes.len() > MAX_NOTES {
        return Err("A project supports at most 200 notes".into());
    }
    let mut ids = HashSet::new();
    for note in notes {
        identifier(&note.id, "Note ID")?;
        if !ids.insert(&note.id) {
            return Err("Duplicate project note ID".into());
        }
        text(&note.title, 160, "Note title")?;
        if note.title.trim().is_empty() {
            return Err("Note title must not be empty".into());
        }
        text(&note.body, MAX_NOTE_BODY, "Note body")?;
        if !(1..=crate::classic::MAX_SAFE_INTEGER as u64).contains(&note.version) {
            return Err("Note version must be a positive safe integer".into());
        }
        if timestamp(&note.updated_at)? < timestamp(&note.created_at)? {
            return Err("Note update must not precede creation".into());
        }
    }
    if serde_json::to_vec(notes).map_err(|e| e.to_string())?.len() > MAX_NOTES_BYTES {
        return Err("Project notes exceed the one MiB document budget".into());
    }
    Ok(())
}
