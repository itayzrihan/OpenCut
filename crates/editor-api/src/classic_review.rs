//! Imported review feedback is project data, never authority over a remote share.
use crate::classic_notes::{identifier, text, timestamp};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientReviewShare {
    pub share_id: String,
    pub version: String,
    pub scene_id: String,
    pub duration_ticks: i64,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientReviewComment {
    pub id: String,
    pub share_id: String,
    pub share_version: String,
    pub scene_id: String,
    pub time_ticks: i64,
    pub body: String,
    pub author_name: String,
    pub server_revision: u64,
    pub resolved: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientReviewState {
    #[serde(default)]
    pub shares: Vec<ClientReviewShare>,
    #[serde(default)]
    pub comments: Vec<ClientReviewComment>,
}

fn uuid(value: &str) -> Result<(), String> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
    {
        return Err("Review IDs must be canonical lowercase UUIDs".into());
    }
    Ok(())
}

impl ClientReviewShare {
    pub(crate) fn validate(&self) -> Result<(), String> {
        uuid(&self.share_id)?;
        identifier(&self.version, "Review render version")?;
        identifier(&self.scene_id, "Review scene ID")?;
        if !(1..=crate::classic::MAX_SAFE_INTEGER).contains(&self.duration_ticks) {
            return Err("Review render duration must be positive safe integer ticks".into());
        }
        timestamp(&self.created_at)?;
        if let Some(title) = &self.title {
            text(title, 160, "Review title")?;
        }
        Ok(())
    }
}

impl ClientReviewState {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.shares.len() > 100 || self.comments.len() > 1000 {
            return Err(
                "Review history supports at most 100 render versions and 1000 imported comments"
                    .into(),
            );
        }
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > 2_097_152 {
            return Err("Imported review history exceeds two MiB".into());
        }
        let mut shares = HashSet::new();
        for share in &self.shares {
            share.validate()?;
            if !shares.insert((&share.share_id, &share.version)) {
                return Err("Duplicate review render version".into());
            }
        }
        let mut ids = HashSet::new();
        for comment in &self.comments {
            uuid(&comment.id)?;
            uuid(&comment.share_id)?;
            if !ids.insert((&comment.share_id, &comment.share_version, &comment.id)) {
                return Err("Duplicate imported review comment".into());
            }
            let share = self
                .shares
                .iter()
                .find(|s| s.share_id == comment.share_id && s.version == comment.share_version)
                .ok_or("Imported comment has no matching rendered share")?;
            if comment.scene_id != share.scene_id
                || !(0..=share.duration_ticks).contains(&comment.time_ticks)
            {
                return Err(
                    "Imported comment does not match the rendered scene or duration".into(),
                );
            }
            if !(1..=crate::classic::MAX_SAFE_INTEGER as u64).contains(&comment.server_revision) {
                return Err("Server comment revision must be a positive safe integer".into());
            }
            text(&comment.body, 8_000, "Review comment")?;
            if comment.body.trim().is_empty() {
                return Err("Review comment must not be empty".into());
            }
            text(&comment.author_name, 160, "Review author name")?;
            if comment.author_name.trim().is_empty() {
                return Err("Review author name must not be empty".into());
            }
            timestamp(&comment.created_at)?;
        }
        Ok(())
    }
}

pub(crate) fn read(value: Option<&Value>) -> Result<ClientReviewState, String> {
    let Some(value) = value else {
        return Ok(ClientReviewState::default());
    };
    if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > 2_097_152 {
        return Err("Imported review history exceeds two MiB".into());
    }
    let state: ClientReviewState =
        serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    state.validate()?;
    Ok(state)
}
