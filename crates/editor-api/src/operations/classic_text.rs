//! Shared exact-tick text partition/merge policy. Renderer measurement is separate.
use super::*;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
pub(super) type Word = (Value, i64, i64, u64);
fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
pub(super) fn tick(value: &Value) -> Result<i64, CapabilityError> {
    value
        .as_i64()
        .filter(|v| (0..=crate::classic::MAX_SAFE_INTEGER).contains(v))
        .ok_or_else(|| invalid("Text timing requires safe nonnegative ticks"))
}
pub(super) fn timed_words(original: &Value) -> Result<Vec<Word>, CapabilityError> {
    let duration = tick(&original["duration"])?;
    let runs = original["wordRuns"]
        .as_array()
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            original["params"]["content"]
                .as_str()
                .unwrap_or("")
                .split('\n')
                .enumerate()
                .flat_map(|(line, text)| {
                    text.split_whitespace()
                        .map(move |text| json!({"text":text,"lineIndex":line}))
                })
                .collect()
        });
    let total = runs.len();
    let mut entries = Vec::new();
    for (index, run) in runs.into_iter().enumerate() {
        if run["text"].as_str().unwrap_or("").trim().is_empty() {
            continue;
        }
        let word_duration = duration as f64 / total as f64;
        let rounded = |i: usize| ((i as f64 * word_duration) + 0.5).floor() as i64;
        let start = run
            .get("startTime")
            .filter(|v| !v.is_null())
            .map(tick)
            .transpose()?
            .unwrap_or_else(|| rounded(index));
        let end = run
            .get("endTime")
            .filter(|v| !v.is_null())
            .map(tick)
            .transpose()?
            .filter(|v| *v > start)
            .unwrap_or_else(|| rounded(index + 1));
        let line = run["lineIndex"].as_u64().unwrap_or(0);
        entries.push((run, start, end, line));
    }
    Ok(entries)
}
pub(super) fn build_part(
    original: &Value,
    entries: Vec<Word>,
    offset: i64,
    duration: i64,
    single_line: bool,
    untimed: bool,
) -> Value {
    let lines: BTreeMap<_, _> = if single_line {
        BTreeMap::from([(0, 0)])
    } else {
        entries
            .iter()
            .map(|v| v.3)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .enumerate()
            .map(|(i, line)| (line, i))
            .collect()
    };
    let words: Vec<_> = entries
        .into_iter()
        .enumerate()
        .map(|(index, (mut run, s, e, line))| {
            let start = (s - offset).max(0);
            run["id"] = json!(format!("word-{index}"));
            run["lineIndex"] = json!(if single_line { 0 } else { lines[&line] });
            if untimed {
                run.as_object_mut().unwrap().remove("startTime");
                run.as_object_mut().unwrap().remove("endTime");
            } else {
                run["startTime"] = json!(start);
                run["endTime"] = json!((e - offset).max(start).min(duration));
            }
            run
        })
        .collect();
    let mut rows: BTreeMap<u64, Vec<&str>> = BTreeMap::new();
    for word in &words {
        rows.entry(word["lineIndex"].as_u64().unwrap())
            .or_default()
            .push(word["text"].as_str().unwrap_or(""));
    }
    let mut copy = original.clone();
    copy["params"]["content"] = json!(
        rows.values()
            .map(|v| v.join(" "))
            .collect::<Vec<_>>()
            .join("\n")
    );
    copy["wordRuns"] = json!(words);
    copy["trimStart"] = json!(0);
    copy["trimEnd"] = json!(0);
    copy["duration"] = json!(duration);
    let overrides: Vec<_> = original["textRowOverrides"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let index = lines.get(&row["lineIndex"].as_u64()?)?;
            let mut row = row.clone();
            row["lineIndex"] = json!(index);
            row["id"] = json!(format!("row-{index}"));
            Some(row)
        })
        .collect();
    if overrides.is_empty() {
        copy.as_object_mut().unwrap().remove("textRowOverrides");
    } else {
        copy["textRowOverrides"] = json!(overrides);
    }
    copy
}
