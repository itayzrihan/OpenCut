//! Explicit delete-and-close-time, using the same signed splice as Classic trim.
use super::{classic_remove::ElementRef, *};
use serde_json::json;

fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn tracks(value: &Value) -> impl Iterator<Item = &Value> {
    value["overlay"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(std::iter::once(&value["main"]))
        .chain(value["audio"].as_array().into_iter().flatten())
}
pub(super) fn ranges(
    value: &Value,
    targets: &[ElementRef],
) -> Result<Vec<(i64, i64)>, CapabilityError> {
    let mut spans = Vec::new();
    for target in targets {
        let track = tracks(value)
            .find(|track| track["id"] == target.track_id)
            .ok_or_else(|| invalid("Track not found"))?;
        let element = track["elements"]
            .as_array()
            .and_then(|items| items.iter().find(|e| e["id"] == target.element_id))
            .ok_or_else(|| invalid("Element not found"))?;
        let start = element["startTime"]
            .as_i64()
            .ok_or_else(|| invalid("Invalid start"))?;
        let duration = element["duration"]
            .as_i64()
            .ok_or_else(|| invalid("Invalid duration"))?;
        spans.push((
            start,
            start
                .checked_add(duration)
                .ok_or_else(|| invalid("Time overflow"))?,
        ));
    }
    spans.sort_unstable();
    let mut merged: Vec<(i64, i64)> = Vec::new();
    for (start, end) in spans {
        if let Some(last) = merged.last_mut().filter(|last| start <= last.1) {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    Ok(merged)
}

// Delegate endpoint mapping to the existing signed trim splice, including its
// half-open boundary behavior. JSON bridges the Classic exact-tick time type.
fn mapped(start: i64, duration: i64, range: (i64, i64)) -> Result<(i64, i64), CapabilityError> {
    let options = serde_json::from_value(json!({
        "clips":[{"id":"span","startTime":start,"duration":duration}],
        "cutTime":range.1,"insertedDuration":range.0-range.1
    }))
    .map_err(|_| invalid("Invalid splice time"))?;
    let output = serde_json::to_value(classic_timeline::ripple_insert_time(options))
        .map_err(|_| invalid("Invalid splice result"))?;
    Ok((
        output[0]["startTime"].as_i64().unwrap(),
        output[0]["duration"].as_i64().unwrap(),
    ))
}
fn keys(
    value: &mut Value,
    old_start: i64,
    new_start: i64,
    range: (i64, i64),
) -> Result<(), CapabilityError> {
    match value {
        Value::Object(object) => {
            if let Some(items) = object.get_mut("keys").and_then(Value::as_array_mut) {
                for key in items {
                    if let Some(time) = key["time"].as_i64() {
                        key["time"] =
                            json!((mapped(old_start + time, 0, range)?.0 - new_start).max(0));
                    }
                }
            } else {
                for child in object.values_mut() {
                    keys(child, old_start, new_start, range)?;
                }
            }
        }
        Value::Array(items) => {
            for child in items {
                keys(child, old_start, new_start, range)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn splice_track(track: &mut Value, range: (i64, i64)) -> Result<(), CapabilityError> {
    let elements = track["elements"]
        .as_array_mut()
        .ok_or_else(|| invalid("Missing elements"))?;
    for element in elements.iter_mut() {
        let start = element["startTime"]
            .as_i64()
            .ok_or_else(|| invalid("Invalid start"))?;
        let duration = element["duration"]
            .as_i64()
            .ok_or_else(|| invalid("Invalid duration"))?;
        let (next, length) = mapped(start, duration, range)?;
        if let Some(words) = element.get_mut("wordRuns").and_then(Value::as_array_mut) {
            for word in words.iter_mut() {
                if let (Some(s), Some(e)) = (word["startTime"].as_i64(), word["endTime"].as_i64()) {
                    let (s, d) = mapped(start + s, e - s, range)?;
                    word["startTime"] = json!(s - next);
                    word["endTime"] = json!(s + d - next);
                }
            }
            words.retain(|w| {
                w["startTime"].is_null() || w["endTime"].as_i64() > w["startTime"].as_i64()
            });
            let mut content = String::new();
            for (i, word) in words.iter().enumerate() {
                if i > 0 {
                    content.push(if word["lineIndex"] == words[i - 1]["lineIndex"] {
                        ' '
                    } else {
                        '\n'
                    });
                }
                content.push_str(word["text"].as_str().unwrap_or(""));
            }
            element["params"]["content"] = json!(content);
        }
        for field in ["animations", "effects"] {
            if let Some(value) = element.get_mut(field) {
                keys(value, start, next, range)?;
            }
        }
        element["startTime"] = json!(next);
        element["duration"] = json!(length);
        if length > 0 && length != duration {
            super::classic_update::transitions(element, &json!({"duration": duration}))?;
        }
    }
    elements.retain(|e| e["duration"].as_i64().is_some_and(|d| d > 0));
    if let Some(words) = track
        .get_mut("captionSource")
        .and_then(|s| s.get_mut("words"))
        .and_then(Value::as_array_mut)
    {
        for word in words.iter_mut() {
            let s = (word["start"]
                .as_f64()
                .ok_or_else(|| invalid("Invalid caption time"))?
                * 120000.0)
                .round() as i64;
            let e = (word["end"]
                .as_f64()
                .ok_or_else(|| invalid("Invalid caption time"))?
                * 120000.0)
                .round() as i64;
            let (s, d) = mapped(s, e - s, range)?;
            word["start"] = json!(s as f64 / 120000.0);
            word["end"] = json!((s + d) as f64 / 120000.0);
        }
        words.retain(|w| w["end"].as_f64() > w["start"].as_f64());
    }
    Ok(())
}
pub(super) fn apply(
    scene: &mut Value,
    before: &Value,
    ranges: &[(i64, i64)],
) -> Result<(), CapabilityError> {
    for range in ranges.iter().rev().copied() {
        let current = &mut scene["tracks"];
        for bucket in ["overlay", "audio"] {
            for track in current[bucket]
                .as_array_mut()
                .ok_or_else(|| invalid("Invalid tracks"))?
            {
                splice_track(track, range)?;
            }
        }
        splice_track(&mut current["main"], range)?;
        if let Some(bookmarks) = scene["bookmarks"].as_array_mut() {
            for bookmark in bookmarks {
                let time = bookmark["time"]
                    .as_i64()
                    .ok_or_else(|| invalid("Invalid bookmark time"))?;
                let (time, duration) =
                    mapped(time, bookmark["duration"].as_i64().unwrap_or(0), range)?;
                bookmark["time"] = json!(time);
                if bookmark.get("duration").is_some() {
                    bookmark["duration"] = json!(duration);
                }
            }
        }
    }
    for original in tracks(before).filter(|track| track["locked"] == true) {
        if tracks(&scene["tracks"]).find(|track| track["id"] == original["id"]) != Some(original) {
            return Err(invalid("Delete and close time would change a locked track"));
        }
    }
    Ok(())
}
