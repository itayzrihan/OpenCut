//! Frame-aware bookmarks, including grouped/range notes and atomic bulk replace.
use super::*;

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Bookmark {
    time: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group_id: Option<String>,
    #[serde(flatten)]
    extensions: Map<String, Value>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
enum BookmarkField {
    Note,
    Color,
    Duration,
    GroupId,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BookmarkUpdates {
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    duration: Option<i64>,
    #[serde(default)]
    group_id: Option<String>,
    /// Remove optional properties. Cleared fields must not also be set.
    #[serde(default)]
    clear: Vec<BookmarkField>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum BookmarkChange {
    Toggle {
        time: i64,
    },
    Remove {
        time: i64,
    },
    Update {
        time: i64,
        updates: BookmarkUpdates,
    },
    Move {
        #[serde(rename = "fromTime")]
        from_time: i64,
        #[serde(rename = "toTime")]
        to_time: i64,
    },
    Replace {
        bookmarks: Vec<Bookmark>,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BookmarkInput {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    change: BookmarkChange,
}

pub(super) fn register_classic_bookmark_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<BookmarkInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.bookmarks.edit",
        "Edit Classic scene bookmarks",
        "Toggle, remove, update, move or replace bookmarks in an explicit Classic scene. Times are integer ticks (120000 per second), rounded to the project's frame grid for individual operations. Bulk replace preserves supplied times and order. Notes, color, duration and groupId are supported; updates.clear removes optional fields. Moving onto another bookmark preserves both, sorted stably; toggle removes the first match, remove deletes all at that frame. Missing update/move targets are unchanged. Preserves unknown metadata and other scenes. Read back at app.state.read /project/classic/document/scenes. Requires projectId, sceneId and expectedRevision; supports dry run, cancellation, registry idempotency, atomic compound edits and undo/redo.",
        "scene",
        AccessLevel::Write,
        false,
        false,
        &["classic", "bookmark", "marker", "note", "range", "group"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Edit bookmarks",
                    Some(input.expected_revision),
                    |document| {
                        let classic =
                            super::classic_scenes::classic_target(document, &input.project_id)?;
                        let fps = classic
                            .settings()
                            .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?
                            .frame_rate_rational;
                        let scene = classic
                            .document
                            .get_mut("scenes")
                            .and_then(Value::as_array_mut)
                            .unwrap()
                            .iter_mut()
                            .find(|scene| scene["id"] == input.scene_id)
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput("Classic scene not found".into())
                            })?;
                        let bookmarks = scene
                            .as_object_mut()
                            .unwrap()
                            .entry("bookmarks")
                            .or_insert_with(|| serde_json::json!([]))
                            .as_array_mut()
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput(
                                    "scene bookmarks must be an array".into(),
                                )
                            })?;
                        let changed = apply_change(bookmarks, input.change, fps)?;
                        if changed {
                            classic.document.get_mut("metadata").unwrap()["updatedAt"] =
                                Value::String(super::classic_scenes::timestamp()?);
                        }
                        Ok(vec![input.project_id, input.scene_id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated Classic bookmarks")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

fn frame_time(time: i64, fps: Rational) -> Result<i64, CapabilityError> {
    if !(0..=crate::classic::MAX_SAFE_INTEGER).contains(&time) {
        return Err(CapabilityError::InvalidInput(
            "bookmark time must be a non-negative safe integer".into(),
        ));
    }
    let period = i128::from(crate::classic::CLASSIC_TICKS_PER_SECOND) * i128::from(fps.denominator);
    let numerator = i128::from(fps.numerator);
    // Same fallback as Classic roundFrameTime for rates with no integer tick grid.
    if period % numerator != 0 {
        return Ok(time);
    }
    let frame = period / numerator;
    let ticks = i128::from(time);
    let rounded = (ticks / frame + i128::from((ticks % frame) * 2 >= frame)) * frame;
    if rounded > i128::from(crate::classic::MAX_SAFE_INTEGER) {
        return Err(CapabilityError::InvalidInput(
            "rounded bookmark exceeds safe integer timing".into(),
        ));
    }
    Ok(rounded as i64)
}

fn apply_change(
    bookmarks: &mut Vec<Value>,
    change: BookmarkChange,
    fps: Rational,
) -> Result<bool, CapabilityError> {
    let index_at =
        |items: &[Value], time: i64| items.iter().position(|b| b["time"].as_i64() == Some(time));
    match change {
        BookmarkChange::Replace {
            bookmarks: replacement,
        } => {
            *bookmarks = replacement
                .into_iter()
                .map(|bookmark| serde_json::to_value(bookmark).unwrap())
                .collect();
        }
        BookmarkChange::Toggle { time } => {
            let time = frame_time(time, fps)?;
            if let Some(index) = index_at(bookmarks, time) {
                bookmarks.remove(index);
            } else {
                bookmarks.push(serde_json::json!({"time":time}));
                bookmarks.sort_by_key(|b| b["time"].as_i64().unwrap());
            }
        }
        BookmarkChange::Remove { time } => {
            let time = frame_time(time, fps)?;
            let before = bookmarks.len();
            bookmarks.retain(|bookmark| bookmark["time"].as_i64() != Some(time));
            return Ok(before != bookmarks.len());
        }
        BookmarkChange::Move { from_time, to_time } => {
            let from = frame_time(from_time, fps)?;
            let to = frame_time(to_time, fps)?;
            if let Some(index) = index_at(bookmarks, from) {
                bookmarks[index]["time"] = Value::from(to);
                bookmarks.sort_by_key(|b| b["time"].as_i64().unwrap());
            }
        }
        BookmarkChange::Update { time, updates } => {
            let time = frame_time(time, fps)?;
            let mut values = Map::new();
            if let Some(note) = updates.note {
                values.insert("note".into(), Value::String(note));
            }
            if let Some(color) = updates.color {
                values.insert("color".into(), Value::String(color));
            }
            if let Some(duration) = updates.duration {
                values.insert("duration".into(), Value::from(duration));
            }
            if let Some(group_id) = updates.group_id {
                values.insert("groupId".into(), Value::String(group_id));
            }
            let clear: Vec<_> = updates
                .clear
                .into_iter()
                .map(|field| match field {
                    BookmarkField::Note => "note",
                    BookmarkField::Color => "color",
                    BookmarkField::Duration => "duration",
                    BookmarkField::GroupId => "groupId",
                })
                .collect();
            if clear.iter().any(|key| values.contains_key(*key)) {
                return Err(CapabilityError::InvalidInput(
                    "bookmark fields cannot be both set and cleared".into(),
                ));
            }
            if let Some(index) = index_at(bookmarks, time) {
                let bookmark = bookmarks[index].as_object_mut().unwrap();
                bookmark.extend(values);
                for key in clear {
                    bookmark.remove(key);
                }
            }
        }
    }
    Ok(true)
}
