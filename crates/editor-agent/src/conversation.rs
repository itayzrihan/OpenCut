//! Public conversation presentation owned by Rust and saved with the editor
//! session. This contains no alternate editable project or provider reasoning.
use crate::{AgentError, ProviderActivity};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const MAX_BYTES: usize = 2_000_000;
const MAX_ENTRIES: usize = 5000;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationEntry {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<crate::InputAttachment>,
    pub id: String,
    pub kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub review: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub activities: Vec<ProviderActivity>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<String>,
    #[serde(default)]
    pub interrupted: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifact_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export: Option<ConversationExport>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationExport {
    pub artifact_id: String,
    pub filename: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationArchive {
    pub schema_version: u32,
    pub account_id: String,
    pub project_id: String,
    pub entries: Vec<ConversationEntry>,
    next_id: u64,
    active_round: Option<String>,
}
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConversationEvent {
    User {
        text: String,
        #[serde(default)]
        attachments: Vec<crate::InputAttachment>,
    },
    Round {
        review: bool,
    },
    Text {
        text: String,
    },
    Summary {
        text: String,
    },
    Status {
        text: String,
    },
    Activities {
        activities: Vec<ProviderActivity>,
    },
    Artifacts { artifact_ids: Vec<String> },
    Review {
        summary: String,
        issues: Vec<String>,
        #[serde(default)]
        artifact_ids: Vec<String>,
    },
    Export {
        artifact_id: String,
        filename: String,
    },
    Pause,
    Close,
}
impl ConversationArchive {
    /// Public history is task data, never a replayable provider/tool envelope.
    /// Keep recent work bounded; artifact IDs remain references, not fresh QA.
    pub fn prior_context(
        &self,
        account: &str,
        project: &str,
        current_request: &str,
    ) -> Result<Vec<serde_json::Value>, AgentError> {
        self.validate(account, project)?;
        let end = self.entries.len()
            - usize::from(
                self.entries
                    .last()
                    .is_some_and(|e| e.kind == "user" && e.text == current_request),
            );
        let mut history = Vec::new();
        let mut bytes = 0;
        for entry in self.entries[..end].iter().rev().take(24) {
            let item = serde_json::json!({
                "messageId": entry.id, "speaker": if entry.kind == "user" {"user"} else {"assistant"},
                "text": excerpt(&entry.text, 4000), "summary": entry.summary.as_ref().map(|s| excerpt(s, 2000)),
                "interrupted": entry.interrupted, "issues": entry.issues.iter().take(8).map(|s| excerpt(s, 256)).collect::<Vec<_>>(),
                "artifactIds": entry.artifact_ids, "attachments": entry.attachments, "export": entry.export,
                "observedActions": entry.activities.iter().rev().take(8).map(|a| serde_json::json!({
                    "title": excerpt(&a.title, 256), "ok": a.ok,
                    "inputExcerpt": excerpt(&a.input.to_string(), 1000),
                    "outputExcerpt": excerpt(&a.output.to_string(), 2000)
                })).collect::<Vec<_>>()
            });
            let size = serde_json::to_vec(&item)
                .map_err(|e| invalid(e.to_string()))?
                .len();
            if bytes + size > 32_000 {
                break;
            }
            bytes += size;
            history.insert(0, item);
        }
        let omitted = end.saturating_sub(history.len());
        if omitted > 0 {
            history.insert(0, serde_json::json!({"omittedEarlierEntries": omitted}));
        }
        Ok(history)
    }
    pub fn new(account_id: String, project_id: String) -> Self {
        Self {
            schema_version: 1,
            account_id,
            project_id,
            entries: vec![],
            next_id: 0,
            active_round: None,
        }
    }
    pub fn validate(&self, account: &str, project: &str) -> Result<(), AgentError> {
        if self.schema_version != 1 || self.account_id != account || self.project_id != project {
            return Err(AgentError::Denied(
                "Conversation belongs to another account/project or unsupported version".into(),
            ));
        }
        if self.next_id > 9_007_199_254_740_990 || self.entries.len() > MAX_ENTRIES {
            return Err(invalid("Conversation quota exceeded"));
        }
        let mut ids = HashSet::new();
        for entry in &self.entries {
            if entry.attachments.len() > 8
                || entry.attachments.iter().any(|a| {
                    a.filename.is_empty()
                        || a.filename.len() > 256
                        || a.artifact_id.is_empty()
                        || a.artifact_id.len() > 256
                        || a.artifact_id.contains("://")
                })
            {
                return Err(invalid("Invalid conversation attachment"));
            }
            if !ids.insert(&entry.id)
                || !matches!(entry.kind.as_str(), "user" | "round" | "status")
                || entry.text.len() > 200_000
                || entry.summary.as_ref().is_some_and(|s| s.len() > 200_000)
                || entry.activities.len() > 64
                || entry.issues.len() > 40
            {
                return Err(invalid("Invalid public conversation entry"));
            }
            let number = entry
                .id
                .strip_prefix("message-")
                .and_then(|s| s.parse::<u64>().ok());
            if number.is_none_or(|n| n == 0 || n > self.next_id) {
                return Err(invalid("Invalid conversation identity"));
            }
            if entry.artifact_ids.len() > 16
                || entry
                    .artifact_ids
                    .iter()
                    .any(|id| id.is_empty() || id.len() > 256 || id.contains("://"))
                || entry.export.as_ref().is_some_and(|e| {
                    e.artifact_id.is_empty()
                        || e.artifact_id.len() > 256
                        || e.artifact_id.contains("://")
                        || e.filename.len() > 256
                })
            {
                return Err(invalid("Invalid conversation artifact reference"));
            }
        }
        if self.active_round.as_ref().is_some_and(|id| {
            !self
                .entries
                .iter()
                .any(|e| &e.id == id && e.kind == "round")
        }) {
            return Err(invalid("Conversation round missing"));
        }
        if serde_json::to_vec(self)
            .map_err(|e| invalid(e.to_string()))?
            .len()
            > MAX_BYTES
        {
            return Err(invalid(
                "Conversation storage quota exceeded; existing messages were preserved",
            ));
        }
        Ok(())
    }
    pub fn apply(
        &mut self,
        account: &str,
        project: &str,
        event: ConversationEvent,
    ) -> Result<(), AgentError> {
        self.validate(account, project)?;
        let mut draft = self.clone();
        match event {
            ConversationEvent::User { text, attachments } => {
                draft.append("user", text, false)?;
                draft.entries.last_mut().unwrap().attachments = attachments;
            }
            ConversationEvent::Status { text } => {
                if draft
                    .entries
                    .last()
                    .is_none_or(|e| e.kind != "status" || e.text != text)
                {
                    draft.append("status", text, false)?;
                }
            }
            ConversationEvent::Round { review } => {
                draft.append("round", String::new(), review)?;
                draft.active_round = draft.entries.last().map(|e| e.id.clone());
            }
            ConversationEvent::Pause => {
                if let Some(entry) = draft.round_mut() {
                    entry.interrupted = true;
                }
                draft.active_round = None;
            }
            ConversationEvent::Close => draft.active_round = None,
            ConversationEvent::Export {
                artifact_id,
                filename,
            } => {
                draft.append("status", "Export ready".into(), false)?;
                draft.entries.last_mut().unwrap().export = Some(ConversationExport {
                    artifact_id,
                    filename,
                });
            }
            event => {
                if matches!(&event, ConversationEvent::Activities { activities } if !activities.is_empty())
                    && draft.active_round.is_none()
                {
                    draft.append("round", String::new(), false)?;
                    draft.active_round = draft.entries.last().map(|e| e.id.clone());
                }
                let entry = draft.round_mut().ok_or_else(|| {
                    invalid("Start a conversation round before its display events")
                })?;
                match event {
                    ConversationEvent::Text { text } => {
                        if !entry.review {
                            entry.text.push_str(&text);
                        }
                    }
                    ConversationEvent::Summary { text } => entry
                        .summary
                        .get_or_insert_with(String::new)
                        .push_str(&text),
                    ConversationEvent::Activities { activities } => {
                        for activity in activities {
                            if let Some(old) = entry
                                .activities
                                .iter_mut()
                                .find(|old| old.call_id == activity.call_id)
                            {
                                *old = activity;
                            } else {
                                entry.activities.push(activity);
                            }
                        }
                    }
                    ConversationEvent::Artifacts { artifact_ids } => {
                        if artifact_ids.len()>8 || artifact_ids.iter().any(|id|id.is_empty() || id.len()>256) {return Err(invalid("Invalid conversation artifact references"));}
                        for id in artifact_ids { if !entry.artifact_ids.contains(&id) {entry.artifact_ids.push(id);} }
                    }
                    ConversationEvent::Review {
                        summary,
                        issues,
                        artifact_ids,
                    } => {
                        entry.text = summary;
                        entry.issues = issues;
                        entry.artifact_ids = artifact_ids;
                    }
                    _ => unreachable!(),
                }
            }
        }
        draft.validate(account, project)?;
        *self = draft;
        Ok(())
    }
    pub fn restore(mut self, account: &str, project: &str) -> Result<Self, AgentError> {
        self.validate(account, project)?;
        self.apply(account, project, ConversationEvent::Pause)?;
        Ok(self)
    }
    fn append(&mut self, kind: &str, text: String, review: bool) -> Result<(), AgentError> {
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| invalid("Conversation identity exhausted"))?;
        self.entries.push(ConversationEntry {
            id: format!("message-{}", self.next_id),
            kind: kind.into(),
            text,
            summary: None,
            review,
            activities: vec![],
            issues: vec![],
            interrupted: false,
            artifact_ids: vec![],
            export: None,
            attachments: vec![],
        });
        Ok(())
    }
    fn round_mut(&mut self) -> Option<&mut ConversationEntry> {
        let id = self.active_round.as_ref()?;
        self.entries.iter_mut().find(|e| &e.id == id)
    }
}

fn excerpt(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.into();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… [excerpt]", &text[..end])
}
fn invalid(message: impl ToString) -> AgentError {
    AgentError::Invalid(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_is_bounded_and_unicode_safe_and_reports_omissions() {
        let mut state = ConversationArchive::new("a".into(), "p".into());
        for _ in 0..40 {
            state
                .apply(
                    "a",
                    "p",
                    ConversationEvent::User {
                        text: "שלום".repeat(1000),
                        attachments: vec![],
                    },
                )
                .unwrap();
        }
        let history = state.prior_context("a", "p", "different request").unwrap();
        assert!(history[0]["omittedEarlierEntries"].as_u64().unwrap() > 0);
        assert!(serde_json::to_vec(&history).unwrap().len() < 33_000);
        assert!(state.prior_context("a", "other", "request").is_err());
    }
    #[test]
    fn public_messages_survive_round_trip_and_resume_without_replaying_actions() {
        let mut state = ConversationArchive::new("account".into(), "project".into());
        for event in [
            ConversationEvent::User {
                text: "ערוך את הווידאו".into(),
                attachments: vec![],
            },
            ConversationEvent::Round { review: false },
            ConversationEvent::Text {
                text: "Hello".into(),
            },
            ConversationEvent::Summary {
                text: "Checking layout".into(),
            },
        ] {
            state.apply("account", "project", event).unwrap();
        }
        let bytes = serde_json::to_string(&state).unwrap();
        let restored: ConversationArchive = serde_json::from_str(&bytes).unwrap();
        let restored = restored.restore("account", "project").unwrap();
        assert_eq!(restored.entries[1].text, "Hello");
        assert!(restored.entries[1].interrupted);
        assert_eq!(
            restored.entries[1].summary.as_deref(),
            Some("Checking layout")
        );
        assert!(restored.clone().restore("other", "project").is_err());
        assert!(
            serde_json::from_str::<ConversationEvent>(
                r#"{"type":"reasoning_text","text":"private"}"#
            )
            .is_err()
        );
    }
    #[test]
    fn invalid_or_oversized_events_preserve_the_previous_conversation() {
        let mut state = ConversationArchive::new("a".into(), "p".into());
        let before = serde_json::to_string(&state).unwrap();
        assert!(
            state
                .apply(
                    "a",
                    "p",
                    ConversationEvent::Text {
                        text: "no round".into()
                    }
                )
                .is_err()
        );
        assert!(
            state
                .apply(
                    "a",
                    "p",
                    ConversationEvent::User {
                        text: "x".repeat(200_001),
                        attachments: vec![]
                    }
                )
                .is_err()
        );
        assert_eq!(serde_json::to_string(&state).unwrap(), before);
    }
}
