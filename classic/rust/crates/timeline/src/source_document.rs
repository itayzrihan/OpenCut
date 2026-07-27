use std::collections::{BTreeMap, HashMap};

use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use time::MediaTime;

const TIMELINE_SOURCE_SCHEMA_VERSION: u64 = 2;
const MAX_SAFE_JAVASCRIPT_INTEGER: i64 = 9_007_199_254_740_991;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalizeTimelineSourceDocumentOptions {
    /// A Timeline Source v2 document encoded as JSON.
    pub json: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSourceDiagnostic {
    pub code: String,
    pub path: String,
    pub message: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalizeTimelineSourceDocumentResult {
    pub valid: bool,
    /// Deterministically formatted JSON. Empty only when the input is not JSON.
    pub formatted_json: String,
    /// SHA-256 of the compact canonical JSON. Empty only when parsing fails.
    pub base_revision: String,
    pub diagnostics: Vec<TimelineSourceDiagnostic>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSourceMutationRange {
    pub start_time: MediaTime,
    pub duration: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateTimelineSourceV2MutationScopeOptions {
    /// Canonical Timeline Source v2 JSON before the proposed mutation.
    pub before_json: String,
    /// Canonical Timeline Source v2 JSON after the proposed mutation.
    pub after_json: String,
    /// When present, only elements wholly contained by this range may change.
    #[serde(default)]
    pub selected_range: Option<TimelineSourceMutationRange>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateTimelineSourceV2MutationScopeResult {
    pub valid: bool,
    pub diagnostics: Vec<TimelineSourceDiagnostic>,
}

/// Parse, validate, and deterministically format a Timeline Source v2 document.
///
/// The v2 envelope intentionally validates only the structural contract owned
/// by the shared timeline core. Every additional nested value is preserved so
/// UI shells can round-trip new element, effect, mask, animation, and caption
/// settings without waiting for this codec to learn their presentation schema.
#[export]
pub fn canonicalize_timeline_source_document(
    CanonicalizeTimelineSourceDocumentOptions { json }: CanonicalizeTimelineSourceDocumentOptions,
) -> CanonicalizeTimelineSourceDocumentResult {
    let parsed = match serde_json::from_str::<Value>(&json) {
        Ok(parsed) => parsed,
        Err(error) => {
            return CanonicalizeTimelineSourceDocumentResult {
                valid: false,
                formatted_json: String::new(),
                base_revision: String::new(),
                diagnostics: vec![TimelineSourceDiagnostic {
                    code: "invalid_json".to_owned(),
                    path: "$".to_owned(),
                    message: format!(
                        "Invalid JSON at line {}, column {}: {}",
                        error.line(),
                        error.column(),
                        error
                    ),
                }],
            };
        }
    };

    let canonical = canonicalize_value(parsed);
    let diagnostics = validate_document(&canonical);
    let mut formatted_json = serde_json::to_string_pretty(&canonical)
        .expect("serializing a serde_json::Value cannot fail");
    formatted_json.push('\n');
    let canonical_bytes =
        serde_json::to_vec(&canonical).expect("serializing a serde_json::Value cannot fail");
    let base_revision = sha256_revision(&canonical_bytes);

    CanonicalizeTimelineSourceDocumentResult {
        valid: diagnostics.is_empty(),
        formatted_json,
        base_revision,
        diagnostics,
    }
}

/// Enforce the persistent mutation boundary for Timeline Source v2.
///
/// Scene identity is immutable for every edit. A selected range additionally
/// freezes project, scene, and track structure and permits element mutations
/// only when every relevant before/after span is wholly inside that range.
/// The web and desktop shells pass canonical JSON so this policy remains
/// shared even if their UI frameworks and in-memory timeline shapes differ.
#[export]
pub fn validate_timeline_source_v2_mutation_scope(
    ValidateTimelineSourceV2MutationScopeOptions {
        before_json,
        after_json,
        selected_range,
    }: ValidateTimelineSourceV2MutationScopeOptions,
) -> ValidateTimelineSourceV2MutationScopeResult {
    let mut diagnostics = Vec::new();
    let before = parse_scope_document(&before_json, "before", &mut diagnostics);
    let after = parse_scope_document(&after_json, "after", &mut diagnostics);
    let (Some(before), Some(after)) = (before, after) else {
        return mutation_scope_result(diagnostics);
    };

    let before_scene = before
        .get("scene")
        .and_then(Value::as_object)
        .expect("validated Timeline Source v2 before document must contain a scene object");
    let after_scene = after
        .get("scene")
        .and_then(Value::as_object)
        .expect("validated Timeline Source v2 after document must contain a scene object");

    if before_scene.get("id") != after_scene.get("id") {
        diagnostics.push(diagnostic(
            "scene_id_changed",
            "$.scene.id",
            "Timeline Source cannot change the active scene id",
        ));
    }
    if before_scene.get("isMain") != after_scene.get("isMain") {
        diagnostics.push(diagnostic(
            "scene_role_changed",
            "$.scene.isMain",
            "Timeline Source cannot change whether the scene is the main scene",
        ));
    }

    let Some(selected_range) = selected_range else {
        return mutation_scope_result(diagnostics);
    };
    let Some(range_end) = valid_mutation_range_end(selected_range) else {
        diagnostics.push(diagnostic(
            "invalid_selected_range",
            "$.selectedRange",
            "The selected range must use non-negative safe integer ticks",
        ));
        return mutation_scope_result(diagnostics);
    };

    if before.get("projectSettings") != after.get("projectSettings") {
        diagnostics.push(diagnostic(
            "range_project_structure_changed",
            "$.projectSettings",
            "A range-scoped edit cannot change project settings",
        ));
    }
    if scene_structure(before_scene) != scene_structure(after_scene) {
        diagnostics.push(diagnostic(
            "range_scene_structure_changed",
            "$.scene",
            "A range-scoped edit cannot change scene metadata or bookmarks",
        ));
    }
    if track_structure(before_scene) != track_structure(after_scene) {
        diagnostics.push(diagnostic(
            "range_track_structure_changed",
            "$.scene.tracks",
            "A range-scoped edit cannot add, remove, reorder, or modify tracks",
        ));
    }

    validate_element_mutations(
        before_scene,
        after_scene,
        selected_range.start_time.as_ticks(),
        range_end,
        &mut diagnostics,
    );
    mutation_scope_result(diagnostics)
}

fn mutation_scope_result(
    diagnostics: Vec<TimelineSourceDiagnostic>,
) -> ValidateTimelineSourceV2MutationScopeResult {
    ValidateTimelineSourceV2MutationScopeResult {
        valid: diagnostics.is_empty(),
        diagnostics,
    }
}

fn parse_scope_document(
    json: &str,
    side: &str,
    diagnostics: &mut Vec<TimelineSourceDiagnostic>,
) -> Option<Value> {
    let document = match serde_json::from_str::<Value>(json) {
        Ok(document) => document,
        Err(error) => {
            diagnostics.push(diagnostic(
                &format!("invalid_{side}_json"),
                &format!("$.{side}"),
                &format!(
                    "Invalid {side} Timeline Source JSON at line {}, column {}: {error}",
                    error.line(),
                    error.column()
                ),
            ));
            return None;
        }
    };

    let document_diagnostics = validate_document(&document);
    if document_diagnostics.is_empty() {
        return Some(canonicalize_value(document));
    }

    diagnostics.extend(document_diagnostics.into_iter().map(|entry| {
        let suffix = entry.path.strip_prefix('$').unwrap_or(&entry.path);
        diagnostic(
            &format!("invalid_{side}_document"),
            &format!("$.{side}{suffix}"),
            &format!("Invalid {side} Timeline Source: {}", entry.message),
        )
    }));
    None
}

fn valid_mutation_range_end(range: TimelineSourceMutationRange) -> Option<i64> {
    let start = range.start_time.as_ticks();
    let duration = range.duration.as_ticks();
    if start < 0
        || duration < 0
        || start > MAX_SAFE_JAVASCRIPT_INTEGER
        || duration > MAX_SAFE_JAVASCRIPT_INTEGER
    {
        return None;
    }
    start
        .checked_add(duration)
        .filter(|end| *end <= MAX_SAFE_JAVASCRIPT_INTEGER)
}

fn scene_structure(scene: &Map<String, Value>) -> Value {
    let mut structure = Map::new();
    for key in ["name", "createdAt", "updatedAt", "bookmarks"] {
        structure.insert(
            key.to_owned(),
            scene.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(structure)
}

fn track_structure(scene: &Map<String, Value>) -> Value {
    let tracks = scene
        .get("tracks")
        .and_then(Value::as_array)
        .expect("validated Timeline Source v2 scene must contain a tracks array");
    Value::Array(
        tracks
            .iter()
            .map(|track| {
                let mut structure = track
                    .as_object()
                    .expect("validated Timeline Source v2 track must be an object")
                    .clone();
                structure.remove("elements");
                Value::Object(structure)
            })
            .collect(),
    )
}

#[derive(Clone, Debug)]
struct ScopeElementEntry {
    track_id: String,
    element: Value,
    path: String,
}

fn collect_scope_elements(scene: &Map<String, Value>) -> BTreeMap<String, ScopeElementEntry> {
    let tracks = scene
        .get("tracks")
        .and_then(Value::as_array)
        .expect("validated Timeline Source v2 scene must contain a tracks array");
    let mut elements = BTreeMap::new();
    for (track_index, track) in tracks.iter().enumerate() {
        let track = track
            .as_object()
            .expect("validated Timeline Source v2 track must be an object");
        let track_id = track
            .get("id")
            .and_then(Value::as_str)
            .expect("validated Timeline Source v2 track must have an id");
        let track_elements = track
            .get("elements")
            .and_then(Value::as_array)
            .expect("validated Timeline Source v2 track must contain an elements array");
        for (element_index, element) in track_elements.iter().enumerate() {
            let id = element
                .get("id")
                .and_then(Value::as_str)
                .expect("validated Timeline Source v2 element must have an id");
            elements.insert(
                id.to_owned(),
                ScopeElementEntry {
                    track_id: track_id.to_owned(),
                    element: element.clone(),
                    path: format!("$.scene.tracks[{track_index}].elements[{element_index}]"),
                },
            );
        }
    }
    elements
}

fn validate_element_mutations(
    before_scene: &Map<String, Value>,
    after_scene: &Map<String, Value>,
    range_start: i64,
    range_end: i64,
    diagnostics: &mut Vec<TimelineSourceDiagnostic>,
) {
    let before_elements = collect_scope_elements(before_scene);
    let after_elements = collect_scope_elements(after_scene);
    let ids = before_elements
        .keys()
        .chain(after_elements.keys())
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();

    for id in ids {
        let before_entry = before_elements.get(&id);
        let after_entry = after_elements.get(&id);
        match (before_entry, after_entry) {
            (Some(before_entry), Some(after_entry)) => {
                if before_entry.track_id == after_entry.track_id
                    && before_entry.element == after_entry.element
                {
                    continue;
                }
                if !scope_contains_element(range_start, range_end, &before_entry.element)
                    || !scope_contains_element(range_start, range_end, &after_entry.element)
                {
                    push_out_of_scope_element(diagnostics, &after_entry.path, &id, "changed");
                }
            }
            (Some(entry), None) => {
                if !scope_contains_element(range_start, range_end, &entry.element) {
                    push_out_of_scope_element(diagnostics, &entry.path, &id, "deleted");
                }
            }
            (None, Some(entry)) => {
                if !scope_contains_element(range_start, range_end, &entry.element) {
                    push_out_of_scope_element(diagnostics, &entry.path, &id, "inserted");
                }
            }
            (None, None) => unreachable!("element id must come from before or after document"),
        }
    }
}

fn scope_contains_element(range_start: i64, range_end: i64, element: &Value) -> bool {
    let Some(start) = element.get("startTime").and_then(Value::as_i64) else {
        return false;
    };
    let Some(duration) = element.get("duration").and_then(Value::as_i64) else {
        return false;
    };
    if start < 0
        || duration < 0
        || start > MAX_SAFE_JAVASCRIPT_INTEGER
        || duration > MAX_SAFE_JAVASCRIPT_INTEGER
    {
        return false;
    }
    let Some(end) = start.checked_add(duration) else {
        return false;
    };
    start >= range_start && end <= range_end
}

fn push_out_of_scope_element(
    diagnostics: &mut Vec<TimelineSourceDiagnostic>,
    path: &str,
    id: &str,
    mutation: &str,
) {
    diagnostics.push(diagnostic(
        "range_element_out_of_scope",
        path,
        &format!("Element \"{id}\" was {mutation} outside the selected range"),
    ));
}

fn canonicalize_value(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let sorted = object
                .into_iter()
                .map(|(key, value)| (key, canonicalize_value(value)))
                .collect::<BTreeMap<_, _>>();
            Value::Object(Map::from_iter(sorted))
        }
        Value::Array(items) => Value::Array(items.into_iter().map(canonicalize_value).collect()),
        scalar => scalar,
    }
}

fn sha256_revision(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut revision = String::with_capacity("sha256:".len() + digest.len() * 2);
    revision.push_str("sha256:");
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut revision, "{byte:02x}").expect("writing to a String cannot fail");
    }
    revision
}

fn validate_document(document: &Value) -> Vec<TimelineSourceDiagnostic> {
    let mut diagnostics = Vec::new();
    let Some(root) = require_object(document, "$", "document", &mut diagnostics) else {
        return diagnostics;
    };

    match root.get("schemaVersion") {
        Some(Value::Number(version))
            if version.as_u64() == Some(TIMELINE_SOURCE_SCHEMA_VERSION) => {}
        Some(_) => diagnostics.push(diagnostic(
            "unsupported_schema_version",
            "$.schemaVersion",
            "schemaVersion must be the integer 2",
        )),
        None => diagnostics.push(diagnostic(
            "missing_schema_version",
            "$.schemaVersion",
            "schemaVersion is required and must be 2",
        )),
    }

    let Some(scene_value) = root.get("scene") else {
        diagnostics.push(diagnostic("missing_scene", "$.scene", "scene is required"));
        return diagnostics;
    };
    let Some(scene) = require_object(scene_value, "$.scene", "scene", &mut diagnostics) else {
        return diagnostics;
    };

    validate_non_empty_id(scene.get("id"), "$.scene.id", "scene", &mut diagnostics);

    let Some(tracks_value) = scene.get("tracks") else {
        diagnostics.push(diagnostic(
            "missing_tracks",
            "$.scene.tracks",
            "scene.tracks is required",
        ));
        return diagnostics;
    };
    let Some(tracks) = require_array(
        tracks_value,
        "$.scene.tracks",
        "scene.tracks",
        &mut diagnostics,
    ) else {
        return diagnostics;
    };

    let mut track_ids = HashMap::<&str, String>::new();
    let mut element_ids = HashMap::<&str, String>::new();
    for (track_index, track_value) in tracks.iter().enumerate() {
        let track_path = format!("$.scene.tracks[{track_index}]");
        let Some(track) = require_object(track_value, &track_path, "track", &mut diagnostics)
        else {
            continue;
        };

        if let Some(track_id) = validate_non_empty_id(
            track.get("id"),
            &format!("{track_path}.id"),
            "track",
            &mut diagnostics,
        ) {
            record_unique_id(
                &mut track_ids,
                track_id,
                &format!("{track_path}.id"),
                "duplicate_track_id",
                "track",
                &mut diagnostics,
            );
        }

        let elements_path = format!("{track_path}.elements");
        let Some(elements_value) = track.get("elements") else {
            diagnostics.push(diagnostic(
                "missing_elements",
                &elements_path,
                "track.elements is required",
            ));
            continue;
        };
        let Some(elements) = require_array(
            elements_value,
            &elements_path,
            "track.elements",
            &mut diagnostics,
        ) else {
            continue;
        };

        for (element_index, element_value) in elements.iter().enumerate() {
            let element_path = format!("{elements_path}[{element_index}]");
            let Some(element) =
                require_object(element_value, &element_path, "element", &mut diagnostics)
            else {
                continue;
            };
            if let Some(element_id) = validate_non_empty_id(
                element.get("id"),
                &format!("{element_path}.id"),
                "element",
                &mut diagnostics,
            ) {
                record_unique_id(
                    &mut element_ids,
                    element_id,
                    &format!("{element_path}.id"),
                    "duplicate_element_id",
                    "element",
                    &mut diagnostics,
                );
            }
        }
    }

    diagnostics
}

fn require_object<'a>(
    value: &'a Value,
    path: &str,
    label: &str,
    diagnostics: &mut Vec<TimelineSourceDiagnostic>,
) -> Option<&'a Map<String, Value>> {
    match value.as_object() {
        Some(object) => Some(object),
        None => {
            diagnostics.push(diagnostic(
                "invalid_shape",
                path,
                &format!("{label} must be an object"),
            ));
            None
        }
    }
}

fn require_array<'a>(
    value: &'a Value,
    path: &str,
    label: &str,
    diagnostics: &mut Vec<TimelineSourceDiagnostic>,
) -> Option<&'a Vec<Value>> {
    match value.as_array() {
        Some(array) => Some(array),
        None => {
            diagnostics.push(diagnostic(
                "invalid_shape",
                path,
                &format!("{label} must be an array"),
            ));
            None
        }
    }
}

fn validate_non_empty_id<'a>(
    value: Option<&'a Value>,
    path: &str,
    label: &str,
    diagnostics: &mut Vec<TimelineSourceDiagnostic>,
) -> Option<&'a str> {
    match value.and_then(Value::as_str) {
        Some(id) if !id.trim().is_empty() => Some(id),
        Some(_) => {
            diagnostics.push(diagnostic(
                "empty_id",
                path,
                &format!("{label}.id must not be empty"),
            ));
            None
        }
        None => {
            diagnostics.push(diagnostic(
                "missing_or_invalid_id",
                path,
                &format!("{label}.id must be a non-empty string"),
            ));
            None
        }
    }
}

fn record_unique_id<'a>(
    seen: &mut HashMap<&'a str, String>,
    id: &'a str,
    path: &str,
    code: &str,
    label: &str,
    diagnostics: &mut Vec<TimelineSourceDiagnostic>,
) {
    if let Some(first_path) = seen.get(id) {
        diagnostics.push(diagnostic(
            code,
            path,
            &format!("Duplicate {label} id \"{id}\"; first declared at {first_path}"),
        ));
    } else {
        seen.insert(id, path.to_owned());
    }
}

fn diagnostic(code: &str, path: &str, message: &str) -> TimelineSourceDiagnostic {
    TimelineSourceDiagnostic {
        code: code.to_owned(),
        path: path.to_owned(),
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonicalize(json: &str) -> CanonicalizeTimelineSourceDocumentResult {
        canonicalize_timeline_source_document(CanonicalizeTimelineSourceDocumentOptions {
            json: json.to_owned(),
        })
    }

    fn validate_scope(
        before: &Value,
        after: &Value,
        selected_range: Option<(i64, i64)>,
    ) -> ValidateTimelineSourceV2MutationScopeResult {
        validate_timeline_source_v2_mutation_scope(ValidateTimelineSourceV2MutationScopeOptions {
            before_json: serde_json::to_string(before).unwrap(),
            after_json: serde_json::to_string(after).unwrap(),
            selected_range: selected_range.map(|(start_time, duration)| {
                TimelineSourceMutationRange {
                    start_time: MediaTime::from_ticks(start_time),
                    duration: MediaTime::from_ticks(duration),
                }
            }),
        })
    }

    fn scope_document() -> Value {
        serde_json::json!({
            "schemaVersion": 2,
            "projectSettings": { "canvasSize": { "width": 1_920, "height": 1_080 } },
            "scene": {
                "id": "scene-1",
                "name": "Scene",
                "isMain": true,
                "createdAt": "2026-07-01T00:00:00.000Z",
                "updatedAt": "2026-07-02T00:00:00.000Z",
                "bookmarks": [{ "time": 120, "note": "Inside" }],
                "tracks": [{
                    "id": "text-track",
                    "name": "Text",
                    "type": "text",
                    "area": "overlay",
                    "hidden": false,
                    "elements": [
                        { "id": "outside", "type": "text", "startTime": 0, "duration": 50, "params": { "content": "Outside" } },
                        { "id": "inside-change", "type": "text", "startTime": 100, "duration": 100, "params": { "content": "Inside" } },
                        { "id": "inside-delete", "type": "text", "startTime": 200, "duration": 100, "params": { "content": "Delete" } }
                    ]
                }]
            }
        })
    }

    #[test]
    fn canonical_format_and_revision_are_stable_across_object_key_order() {
        let first = canonicalize(
            r#"{
                "scene": {
                    "tracks": [{"elements": [], "name": "Video", "id": "track-1"}],
                    "name": "Main",
                    "id": "scene-1"
                },
                "schemaVersion": 2,
                "metadata": {"z": 2, "a": 1}
            }"#,
        );
        let second = canonicalize(
            r#"{"metadata":{"a":1,"z":2},"schemaVersion":2,"scene":{"id":"scene-1","name":"Main","tracks":[{"id":"track-1","name":"Video","elements":[]}]}}"#,
        );

        assert!(first.valid);
        assert_eq!(first.formatted_json, second.formatted_json);
        assert_eq!(first.base_revision, second.base_revision);
        assert!(first.formatted_json.ends_with('\n'));
        assert_eq!(first.base_revision.len(), "sha256:".len() + 64);
        assert!(first.base_revision.starts_with("sha256:"));
        assert!(first.diagnostics.is_empty());
    }

    #[test]
    fn base_revision_uses_sha256_of_compact_canonical_json() {
        let result = canonicalize(r#"{"schemaVersion":2,"scene":{"tracks":[],"id":"scene-1"}}"#);

        assert!(result.valid);
        assert_eq!(
            result.base_revision,
            "sha256:b8634837ff5195d1c899085ba2899cf5565dba0062d29091654db610ad284a56"
        );
    }

    #[test]
    fn preserves_arbitrary_nested_full_fidelity_state() {
        let input = serde_json::json!({
            "schemaVersion": 2,
            "projectSettings": {
                "fps": { "numerator": 30_000, "denominator": 1_001 },
                "canvasSize": { "width": 3_840, "height": 2_160 }
            },
            "scene": {
                "id": "scene-1",
                "bookmarks": [{ "time": 120_000, "note": "Impact" }],
                "captionSource": {
                    "words": [{ "text": "Epic", "start": 0.0, "end": 0.4 }],
                    "settings": { "revealMode": "spoken-word", "accentColor": "#ff00ff" }
                },
                "tracks": [{
                    "id": "track-1",
                    "type": "graphic",
                    "hidden": false,
                    "elements": [{
                        "id": "element-1",
                        "type": "graphic",
                        "params": { "html": "<div>full fidelity</div>", "perspectiveX": 14.5 },
                        "effects": [{ "id": "effect-1", "type": "rgb-split", "enabled": true, "params": { "amount": 0.25 } }],
                        "masks": [{ "id": "mask-1", "type": "freeform", "params": { "closed": true, "path": [{ "id": "p1", "x": 0.2, "y": 0.8 }] } }],
                        "animations": {
                            "color": {
                                "r": { "keys": [{ "id": "kf-1", "time": 0, "value": 1.0, "segmentToNext": "bezier", "leftHandle": { "dt": -20, "dv": 0.1 } }] },
                                "g": { "keys": [{ "id": "kf-1", "time": 0, "value": 0.2, "segmentToNext": "bezier" }] }
                            }
                        }
                    }]
                }]
            }
        });
        let result = canonicalize(&serde_json::to_string(&input).unwrap());

        assert!(result.valid, "{:?}", result.diagnostics);
        let output: Value = serde_json::from_str(&result.formatted_json).unwrap();
        assert_eq!(output, input);
        assert_eq!(
            output["scene"]["tracks"][0]["elements"][0]["masks"][0]["params"]["path"][0]["id"],
            "p1"
        );
        assert_eq!(
            output["scene"]["captionSource"]["settings"]["revealMode"],
            "spoken-word"
        );
    }

    #[test]
    fn reports_duplicate_track_ids_at_the_later_declaration() {
        let result = canonicalize(
            r#"{
                "schemaVersion": 2,
                "scene": {
                    "id": "scene-1",
                    "tracks": [
                        {"id": "same", "elements": []},
                        {"id": "same", "elements": []}
                    ]
                }
            }"#,
        );

        assert!(!result.valid);
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].code, "duplicate_track_id");
        assert_eq!(result.diagnostics[0].path, "$.scene.tracks[1].id");
        assert!(
            result.diagnostics[0]
                .message
                .contains("$.scene.tracks[0].id")
        );
        assert!(!result.formatted_json.is_empty());
        assert!(!result.base_revision.is_empty());
    }

    #[test]
    fn reports_duplicate_element_ids_across_tracks() {
        let result = canonicalize(
            r#"{
                "schemaVersion": 2,
                "scene": {
                    "id": "scene-1",
                    "tracks": [
                        {"id": "track-1", "elements": [{"id": "element-1"}]},
                        {"id": "track-2", "elements": [{"id": "element-1"}]}
                    ]
                }
            }"#,
        );

        assert!(!result.valid);
        let duplicate = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "duplicate_element_id")
            .expect("duplicate element diagnostic");
        assert_eq!(duplicate.path, "$.scene.tracks[1].elements[0].id");
        assert!(
            duplicate
                .message
                .contains("$.scene.tracks[0].elements[0].id")
        );
    }

    #[test]
    fn rejects_invalid_json_without_format_or_revision() {
        let result = canonicalize(r#"{"schemaVersion":2,"scene":]"#);

        assert!(!result.valid);
        assert!(result.formatted_json.is_empty());
        assert!(result.base_revision.is_empty());
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].code, "invalid_json");
        assert_eq!(result.diagnostics[0].path, "$");
        assert!(result.diagnostics[0].message.contains("line 1"));
    }

    #[test]
    fn validates_required_v2_envelope_fields() {
        let result = canonicalize(r#"{"schemaVersion":1,"scene":{"id":"","tracks":{}}}"#);

        assert!(!result.valid);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            vec!["unsupported_schema_version", "empty_id", "invalid_shape"]
        );
        assert_eq!(result.diagnostics[2].path, "$.scene.tracks");

        let missing = canonicalize(r#"{}"#);
        assert_eq!(
            missing
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            vec!["missing_schema_version", "missing_scene"]
        );
    }

    #[test]
    fn validates_track_and_element_shapes_and_ids() {
        let result = canonicalize(
            r#"{
                "schemaVersion": 2,
                "scene": {
                    "id": "scene-1",
                    "tracks": [
                        null,
                        {"id": 42},
                        {"id": "track-3", "elements": [null, {"name": "missing id"}, {"id": ""}]}
                    ]
                }
            }"#,
        );

        assert!(!result.valid);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .map(|diagnostic| (diagnostic.code.as_str(), diagnostic.path.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("invalid_shape", "$.scene.tracks[0]"),
                ("missing_or_invalid_id", "$.scene.tracks[1].id"),
                ("missing_elements", "$.scene.tracks[1].elements"),
                ("invalid_shape", "$.scene.tracks[2].elements[0]"),
                ("missing_or_invalid_id", "$.scene.tracks[2].elements[1].id"),
                ("empty_id", "$.scene.tracks[2].elements[2].id"),
            ]
        );
    }

    #[test]
    fn array_order_is_preserved_and_part_of_the_revision() {
        let first = canonicalize(
            r#"{"schemaVersion":2,"scene":{"id":"scene-1","tracks":[{"id":"a","elements":[]},{"id":"b","elements":[]}]}}"#,
        );
        let second = canonicalize(
            r#"{"schemaVersion":2,"scene":{"id":"scene-1","tracks":[{"id":"b","elements":[]},{"id":"a","elements":[]}]}}"#,
        );

        assert!(first.valid && second.valid);
        assert_ne!(first.formatted_json, second.formatted_json);
        assert_ne!(first.base_revision, second.base_revision);
    }

    #[test]
    fn mutation_scope_always_protects_scene_identity_and_role() {
        let before = scope_document();
        let mut after = before.clone();
        after["scene"]["id"] = serde_json::json!("other-scene");
        after["scene"]["isMain"] = serde_json::json!(false);
        after["projectSettings"]["canvasSize"]["width"] = serde_json::json!(720);

        let result = validate_scope(&before, &after, None);

        assert!(!result.valid);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            vec!["scene_id_changed", "scene_role_changed"]
        );
    }

    #[test]
    fn range_scope_allows_element_mutations_wholly_inside_the_range() {
        let before = scope_document();
        let mut after = before.clone();
        after["scene"]["tracks"][0]["elements"][1]["params"]["content"] =
            serde_json::json!("Changed");
        after["scene"]["tracks"][0]["elements"]
            .as_array_mut()
            .unwrap()
            .retain(|element| element["id"] != "inside-delete");
        after["scene"]["tracks"][0]["elements"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "inside-insert",
                "type": "text",
                "startTime": 100,
                "duration": 200,
                "params": { "content": "Inclusive boundaries" }
            }));

        let result = validate_scope(&before, &after, Some((100, 200)));

        assert!(result.valid, "{:?}", result.diagnostics);
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn range_scope_rejects_structural_and_out_of_range_mutations() {
        let before = scope_document();
        let mut after = before.clone();
        after["projectSettings"]["canvasSize"]["width"] = serde_json::json!(720);
        after["scene"]["name"] = serde_json::json!("Renamed");
        after["scene"]["tracks"][0]["hidden"] = serde_json::json!(true);
        after["scene"]["tracks"][0]["elements"][0]["params"]["content"] =
            serde_json::json!("Changed outside");

        let result = validate_scope(&before, &after, Some((100, 200)));

        assert!(!result.valid);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            vec![
                "range_project_structure_changed",
                "range_scene_structure_changed",
                "range_track_structure_changed",
                "range_element_out_of_scope",
            ]
        );
    }

    #[test]
    fn mutation_scope_fails_closed_for_invalid_json_and_ranges() {
        let document = scope_document();
        let invalid_json = validate_timeline_source_v2_mutation_scope(
            ValidateTimelineSourceV2MutationScopeOptions {
                before_json: "{".to_owned(),
                after_json: serde_json::to_string(&document).unwrap(),
                selected_range: None,
            },
        );
        assert!(!invalid_json.valid);
        assert_eq!(invalid_json.diagnostics[0].code, "invalid_before_json");

        let invalid_range = validate_scope(&document, &document, Some((-1, 20)));
        assert!(!invalid_range.valid);
        assert_eq!(invalid_range.diagnostics[0].code, "invalid_selected_range");
    }
}
