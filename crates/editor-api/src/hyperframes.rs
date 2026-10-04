//! Lossless HyperFrames source packages and static inspection.
//!
//! HTML is source, not an intermediate video. Inspection never executes scripts
//! or fetches URLs. A runtime manifest is still needed for generated DOM,
//! expression timing, natural media durations and animation adapters.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use schemars::JsonSchema;
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ModelError;

pub(crate) const MAX_SOURCE_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_FILES: usize = 512;
const MAX_ELEMENTS: usize = 20_000;
const MAX_DEPTH: usize = 32;

/// Text remains byte-for-byte intact; binary resources reference existing
/// OpenCut media assets so project persistence owns their lifetime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesSource {
    pub entry_file: String,
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub resource_asset_ids: BTreeMap<String, String>,
    /// Explicit render-time values; author files remain byte-identical.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub variables: BTreeMap<String, serde_json::Value>,
}

impl HyperframesSource {
    pub fn validate(&self) -> Result<(), ModelError> {
        validate_package_path(&self.entry_file)?;
        if !self.files.contains_key(&self.entry_file) {
            return invalid("HyperFrames entryFile is missing from files");
        }
        if self.files.len() + self.resource_asset_ids.len() > MAX_FILES {
            return invalid("HyperFrames package exceeds 512 files");
        }
        if self.files.values().map(String::len).sum::<usize>() > MAX_SOURCE_BYTES {
            return invalid("HyperFrames source exceeds 16 MiB");
        }
        for path in self.files.keys().chain(self.resource_asset_ids.keys()) {
            validate_package_path(path)?;
        }
        for (path, id) in &self.resource_asset_ids {
            if id.trim().is_empty() || self.files.contains_key(path) {
                return invalid("HyperFrames resource must have an asset ID and a unique path");
            }
        }
        if !self.variables.is_empty() {
            crate::hyperframes_variables::validate_variables(self)?;
        }
        Ok(())
    }

    pub fn fingerprint(&self) -> String {
        // BTreeMap guarantees stable ordering, independent of upload order.
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(self).expect("source serializes"))
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HyperframesComposition {
    /// Share immutable source across canonical snapshots and undo history.
    /// JSON still contains the full package so reopen does not depend on a cache.
    pub source: Arc<HyperframesSource>,
    pub composition_id: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_seconds: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_manifest: Option<crate::HyperframesRuntimeManifest>,
}

impl HyperframesComposition {
    pub fn validate(&self) -> Result<(), ModelError> {
        self.source.validate()?;
        if let Some(manifest) = &self.runtime_manifest {
            manifest.validate(&self.source)?;
            if (manifest.duration_seconds - self.duration_seconds).abs() > 0.000_001 {
                return invalid(
                    "HyperFrames runtime manifest duration differs from its composition",
                );
            }
        }
        if self.composition_id.trim().is_empty()
            || self.width == 0
            || self.height == 0
            || self.width > 16_384
            || self.height > 16_384
            || !self.fps.is_finite()
            || self.fps <= 0.0
            || self.fps > 240.0
            || !self.duration_seconds.is_finite()
            || self.duration_seconds <= 0.0
        {
            return invalid(
                "HyperFrames composition requires an ID, valid dimensions, fps and duration",
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HyperframesInspection {
    pub fingerprint: String,
    pub composition_id: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// None means a live HyperFrames runtime must resolve the duration.
    pub duration_seconds: Option<f64>,
    pub elements: Vec<HyperframesElement>,
    pub dependencies: Vec<HyperframesDependency>,
    pub diagnostics: Vec<HyperframesDiagnostic>,
    pub requires_runtime: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HyperframesElement {
    /// Identity includes every host occurrence; author IDs may repeat in files.
    pub key: String,
    pub parent_key: Option<String>,
    pub file: String,
    pub element_id: Option<String>,
    pub tag: String,
    pub label: Option<String>,
    pub track_index: Option<i32>,
    /// Authored attributes are retained even when static timing is unresolved.
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HyperframesDependency {
    pub file: String,
    pub reference: String,
    pub package_path: Option<String>,
    pub status: HyperframesDependencyStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HyperframesDependencyStatus {
    Source,
    Asset,
    Missing,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HyperframesDiagnostic {
    pub code: String,
    pub file: String,
    pub message: String,
}

pub fn inspect_hyperframes(
    source: &HyperframesSource,
) -> Result<HyperframesInspection, ModelError> {
    source.validate()?;
    let html = Html::parse_document(&source.files[&source.entry_file]);
    let roots = Selector::parse("[data-composition-id]").expect("static selector");
    let root = html.select(&roots).next().ok_or_else(|| {
        ModelError::Invalid("HyperFrames entry file requires a data-composition-id root".into())
    })?;
    if root
        .ancestors()
        .filter_map(ElementRef::wrap)
        .any(|el| el.value().name() == "template")
    {
        return invalid("HyperFrames standalone entry root must not be inside a template");
    }
    let config = source
        .files
        .get("hyperframes.json")
        .map(|text| {
            serde_json::from_str::<serde_json::Value>(text.strip_prefix('\u{feff}').unwrap_or(text))
                .map_err(|error| ModelError::Invalid(format!("invalid hyperframes.json: {error}")))
        })
        .transpose()?
        .unwrap_or_default();
    if source.files.contains_key("hyperframes.json") && !config.is_object() {
        return invalid("hyperframes.json must be an object");
    }
    for field in ["width", "height", "fps"] {
        if config.get(field).is_some_and(|value| !value.is_number()) {
            return invalid(&format!("HyperFrames config {field} must be a number"));
        }
    }
    let dimension = |attribute, field, fallback| -> Result<u32, ModelError> {
        let value = numeric_attribute(root, attribute)?
            .or_else(|| config.get(field).and_then(serde_json::Value::as_f64))
            .unwrap_or(fallback);
        if !value.is_finite() || !(1.0..=16_384.0).contains(&value) || value.fract() != 0.0 {
            return invalid(&format!("invalid HyperFrames {field}"));
        }
        Ok(value as u32)
    };
    let fps = config
        .get("fps")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(30.0);
    if !fps.is_finite() || fps <= 0.0 || fps > 240.0 {
        return invalid("invalid HyperFrames fps");
    }
    let duration_seconds = numeric_attribute(root, "data-duration")?;
    if duration_seconds.is_some_and(|duration| duration <= 0.0) {
        return invalid("HyperFrames root duration must be positive");
    }
    let composition_id = root.value().attr("data-composition-id").unwrap().to_owned();
    if composition_id.trim().is_empty() {
        return invalid("HyperFrames composition ID is empty");
    }
    let mut inspection = HyperframesInspection {
        fingerprint: source.fingerprint(),
        composition_id,
        width: dimension("data-width", "width", 1920.0)?,
        height: dimension("data-height", "height", 1080.0)?,
        fps,
        duration_seconds,
        elements: Vec::new(),
        dependencies: Vec::new(),
        diagnostics: Vec::new(),
        requires_runtime: duration_seconds.is_none(),
    };
    let mut visiting = BTreeSet::new();
    inspect_file(
        source,
        &source.entry_file,
        None,
        "root",
        &mut visiting,
        &mut inspection,
    )?;
    // This inventory intentionally does not claim to resolve CSS url(), JS
    // imports, dynamic DOM or animation duration. The source package preserves
    // all of them for the compiler/runtime integration.
    inspection.diagnostics.push(HyperframesDiagnostic {
        code: "static-inventory".into(), file: source.entry_file.clone(),
        message: "Static HTML inventory; generated layers, CSS/JS dependencies and expression timing require the HyperFrames runtime.".into(),
    });
    Ok(inspection)
}

fn inspect_file(
    source: &HyperframesSource,
    file: &str,
    parent_key: Option<&str>,
    scope: &str,
    visiting: &mut BTreeSet<String>,
    inspection: &mut HyperframesInspection,
) -> Result<(), ModelError> {
    if visiting.len() >= MAX_DEPTH || !visiting.insert(file.to_owned()) {
        return invalid("HyperFrames sub-compositions contain a cycle or exceed 32 levels");
    }
    let html = Html::parse_document(&source.files[file]);
    let selector = Selector::parse("*").expect("static selector");
    let mut node_keys = BTreeMap::new();
    for (ordinal, element) in html.select(&selector).enumerate() {
        let value = element.value();
        let attrs: BTreeMap<String, String> =
            value.attrs().map(|(k, v)| (k.into(), v.into())).collect();
        if value.name() == "script" {
            inspection.requires_runtime = true;
        }
        let timed = attrs.contains_key("data-start")
            || attrs.contains_key("data-duration")
            || attrs.contains_key("data-track-index")
            || attrs.contains_key("data-composition-src");
        let key = format!("{scope}/{ordinal}");
        if timed {
            if inspection.elements.len() >= MAX_ELEMENTS {
                return invalid("HyperFrames inventory exceeds 20000 elements");
            }
            let ancestor_key = element
                .ancestors()
                .find_map(|node| node_keys.get(&node.id()).cloned())
                .or_else(|| parent_key.map(str::to_owned));
            node_keys.insert(element.id(), key.clone());
            inspection.elements.push(HyperframesElement {
                key: key.clone(),
                parent_key: ancestor_key,
                file: file.into(),
                element_id: attrs.get("id").or_else(|| attrs.get("data-hf-id")).cloned(),
                tag: value.name().into(),
                label: attrs
                    .get("data-label")
                    .or_else(|| attrs.get("aria-label"))
                    .cloned(),
                track_index: attrs.get("data-track-index").and_then(|v| v.parse().ok()),
                attributes: attrs.clone(),
            });
        }
        for attribute in ["src", "href", "poster", "data-composition-src"] {
            let Some(reference) = attrs.get(attribute) else {
                continue;
            };
            if reference.starts_with('#') || reference.starts_with("data:") {
                continue;
            }
            let package_path = resolve_reference(file, reference)?;
            let status = match package_path.as_ref() {
                None => HyperframesDependencyStatus::External,
                Some(path) if source.files.contains_key(path) => {
                    HyperframesDependencyStatus::Source
                }
                Some(path) if source.resource_asset_ids.contains_key(path) => {
                    HyperframesDependencyStatus::Asset
                }
                Some(_) => HyperframesDependencyStatus::Missing,
            };
            let dep = HyperframesDependency {
                file: file.into(),
                reference: reference.clone(),
                package_path: package_path.clone(),
                status,
            };
            if !inspection.dependencies.contains(&dep) {
                inspection.dependencies.push(dep);
            }
            if attribute == "data-composition-src" {
                match (package_path, status) {
                    (Some(path), HyperframesDependencyStatus::Source) => {
                        inspect_file(source, &path, Some(&key), &key, visiting, inspection)?;
                    }
                    _ => inspection.diagnostics.push(HyperframesDiagnostic {
                        code: "unresolved-composition".into(),
                        file: file.into(),
                        message: format!(
                            "Sub-composition `{reference}` is not present as package source"
                        ),
                    }),
                }
            }
        }
    }
    visiting.remove(file);
    Ok(())
}

fn numeric_attribute(element: ElementRef<'_>, attribute: &str) -> Result<Option<f64>, ModelError> {
    element
        .value()
        .attr(attribute)
        .map(|value| {
            value
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())
                .ok_or_else(|| ModelError::Invalid(format!("invalid HyperFrames {attribute}")))
        })
        .transpose()
}

pub(crate) fn validate_package_path(path: &str) -> Result<(), ModelError> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains(['\\', ':', '?', '#'])
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return invalid(&format!("invalid HyperFrames package path `{path}`"));
    }
    Ok(())
}

pub(crate) fn resolve_reference(file: &str, reference: &str) -> Result<Option<String>, ModelError> {
    if reference.starts_with("//") || reference.split('/').next().unwrap_or("").contains(':') {
        return Ok(None);
    }
    let reference = reference.split(['?', '#']).next().unwrap_or("");
    let reference = percent_encoding::percent_decode_str(reference)
        .decode_utf8()
        .map_err(|_| ModelError::Invalid("HyperFrames URL is not valid UTF-8".into()))?;
    if reference.contains('\\') {
        return invalid(&format!(
            "HyperFrames reference is not a package-relative path: `{reference}`"
        ));
    }
    let mut parts: Vec<_> = if reference.starts_with('/') {
        Vec::new()
    } else {
        let mut parent: Vec<_> = file.split('/').collect();
        parent.pop();
        parent
    };
    for part in reference.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return invalid("HyperFrames reference escapes the source package");
                }
            }
            _ => parts.push(part),
        }
    }
    let path = parts.join("/");
    validate_package_path(&path)?;
    Ok(Some(path))
}

fn invalid<T>(message: &str) -> Result<T, ModelError> {
    Err(ModelError::Invalid(message.into()))
}
