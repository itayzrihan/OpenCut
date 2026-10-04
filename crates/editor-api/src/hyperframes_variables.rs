//! The official HyperFrames render-variable contract, owned by the canonical model.
use crate::{
    ClassicProject, HyperframesComposition, HyperframesRuntimeManifest, HyperframesSource,
    ModelError,
};
use schemars::JsonSchema;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HyperframesVariable {
    pub id: String,
    pub file: String,
    pub declaration: Value,
}

fn invalid(message: &str) -> ModelError {
    ModelError::Invalid(format!("HyperFrames variables: {message}"))
}

/// Keep declarations from each file: one global override must satisfy every
/// declaration using its ID, including repeated/nested composition instances.
pub fn hyperframes_variables(
    source: &HyperframesSource,
) -> Result<Vec<HyperframesVariable>, ModelError> {
    let selector = Selector::parse("[data-composition-variables]").unwrap();
    let mut result = Vec::new();
    for (file, content) in &source.files {
        if !file.to_ascii_lowercase().ends_with(".html")
            && !file.to_ascii_lowercase().ends_with(".htm")
        {
            continue;
        }
        let document = Html::parse_document(content);
        for element in document.select(&selector) {
            let Some(declarations) = element
                .value()
                .attr("data-composition-variables")
                .and_then(|raw| serde_json::from_str::<Vec<Value>>(raw).ok())
            else {
                continue;
            };
            for mut declaration in declarations {
                let Some(id) = declaration["id"].as_str() else {
                    continue;
                };
                if id.is_empty()
                    || id.len() > 128
                    || ["__proto__", "constructor", "prototype"].contains(&id)
                {
                    continue;
                }
                if !matches!(
                    declaration["type"].as_str(),
                    Some("string" | "number" | "boolean" | "color" | "enum" | "font" | "image")
                ) {
                    continue;
                }
                let id = id.to_owned();
                let object = declaration.as_object_mut().unwrap();
                for field in ["label", "description", "placeholder"] {
                    if object.get(field).is_some_and(|v| !v.is_string()) {
                        object.remove(field);
                    }
                }
                for field in ["min", "max", "step"] {
                    if object
                        .get(field)
                        .is_some_and(|v| v.as_f64().is_none_or(|n| !n.is_finite()))
                    {
                        object.remove(field);
                    }
                }
                if object
                    .get("maxLength")
                    .is_some_and(|v| v.as_u64().is_none())
                {
                    object.remove("maxLength");
                }
                if let Some(options) = object.get_mut("options") {
                    if let Some(options) = options.as_array_mut() {
                        options.retain(|option| option["value"].is_string());
                        for option in options {
                            if option.get("label").is_some_and(|v| !v.is_string()) {
                                option.as_object_mut().unwrap().remove("label");
                            }
                        }
                    } else {
                        object.remove("options");
                    }
                }
                result.push(HyperframesVariable {
                    id,
                    file: file.clone(),
                    declaration,
                });
                if result.len() > 2_000 {
                    return Err(invalid("too many declarations"));
                }
            }
        }
    }
    Ok(result)
}

pub(crate) fn validate_variables(source: &HyperframesSource) -> Result<(), ModelError> {
    if source.variables.len() > 256
        || serde_json::to_vec(&source.variables)
            .map_err(|e| invalid(&e.to_string()))?
            .len()
            > 256 * 1024
    {
        return Err(invalid("values exceed the 256-variable or 256 KiB limit"));
    }
    let declarations = hyperframes_variables(source)?;
    for (id, value) in &source.variables {
        let matches: Vec<_> = declarations.iter().filter(|item| item.id == *id).collect();
        if matches.is_empty() {
            return Err(invalid(&format!("{id} is not declared")));
        }
        for item in matches {
            let d = &item.declaration;
            let valid = match d["type"].as_str().unwrap() {
                "string" => value.as_str().is_some_and(|s| {
                    d["maxLength"]
                        .as_u64()
                        .is_none_or(|max| s.encode_utf16().count() as u64 <= max)
                }),
                "color" => value.is_string(),
                "boolean" => value.is_boolean(),
                "number" => value.as_f64().is_some_and(|n| {
                    n.is_finite()
                        && d["min"].as_f64().is_none_or(|min| n >= min)
                        && d["max"].as_f64().is_none_or(|max| n <= max)
                }),
                "enum" => {
                    value.is_string()
                        && d["options"].as_array().is_some_and(|options| {
                            options.iter().any(|option| option["value"] == *value)
                        })
                }
                "font" => {
                    value.is_string()
                        || (value.is_object()
                            && value["name"].is_string()
                            && value["source"].is_string())
                }
                "image" => value.is_string() || (value.is_object() && value["url"].is_string()),
                _ => false,
            };
            if !valid {
                return Err(invalid(&format!(
                    "{id} does not satisfy its {} declaration in {}",
                    d["type"].as_str().unwrap(),
                    item.file
                )));
            }
        }
    }
    Ok(())
}

impl HyperframesSource {
    pub fn with_variables(&self, variables: BTreeMap<String, Value>) -> Result<Self, ModelError> {
        let mut source = self.clone();
        source.variables = variables;
        source.validate()?;
        Ok(source)
    }
}

impl ClassicProject {
    pub fn hyperframes_clip_composition(
        &self,
        scene_id: &str,
        element_id: &str,
    ) -> Result<(String, HyperframesComposition, Value), ModelError> {
        let scene = self
            .scenes()?
            .iter()
            .find(|scene| scene["id"] == scene_id)
            .ok_or_else(|| invalid("scene does not exist"))?;
        for track in crate::classic::tracks(scene)? {
            if let Some(element) = track["elements"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["id"] == element_id)
            {
                if track["locked"] == true || element["locked"] == true {
                    return Err(invalid("clip or track is locked"));
                }
                if element["definitionId"] != "hyperframes" {
                    return Err(invalid("clip is not a HyperFrames composition"));
                }
                let id = element["params"]["hyperframesAssetId"]
                    .as_str()
                    .ok_or_else(|| invalid("source is missing"))?;
                let composition = self
                    .compositions()?
                    .remove(id)
                    .ok_or_else(|| invalid("composition is missing"))?;
                return Ok((id.to_owned(), composition, element.clone()));
            }
        }
        Err(invalid("clip does not exist"))
    }

    pub fn set_hyperframes_variables(
        &mut self,
        scene_id: &str,
        element_id: &str,
        variables: BTreeMap<String, Value>,
        manifest: HyperframesRuntimeManifest,
    ) -> Result<(), ModelError> {
        let (old_id, mut composition, mut element) =
            self.hyperframes_clip_composition(scene_id, element_id)?;
        let source = composition.source.with_variables(variables)?;
        manifest.validate(&source)?;
        // Opacity targets may survive a text/color change, but never a changed DOM identity.
        if let Some(value) = element.get_mut("hyperframesLayerEdits") {
            let old = composition
                .runtime_manifest
                .as_ref()
                .ok_or_else(|| invalid("layer manifest is missing"))?;
            let mut edits: crate::HyperframesLayerEdits =
                serde_json::from_value(value.clone()).map_err(|e| invalid(&e.to_string()))?;
            edits.prepare(&composition.source, old)?;
            let identities = |m: &HyperframesRuntimeManifest| {
                m.layers
                    .iter()
                    .map(|l| {
                        (
                            l.key.clone(),
                            l.parent_key.clone(),
                            l.file.clone(),
                            l.element_id.clone(),
                            l.kind,
                        )
                    })
                    .collect::<Vec<_>>()
            };
            if identities(old) != identities(&manifest) {
                return Err(invalid(
                    "layer structure changed; reset layer opacity edits before changing these variables",
                ));
            }
            edits.source_fingerprint = manifest.source_fingerprint.clone();
            edits.manifest_fingerprint = crate::hyperframes_manifest_fingerprint(&manifest);
            edits.prepare(&source, &manifest)?;
            *value = serde_json::to_value(edits).map_err(|e| invalid(&e.to_string()))?;
        }
        let source_ticks =
            (manifest.duration_seconds * crate::CLASSIC_TICKS_PER_SECOND as f64).round();
        let used_ticks = element["trimStart"].as_f64().unwrap_or(0.0)
            + element["duration"].as_f64().unwrap_or(0.0);
        if source_ticks > 9_007_199_254_740_991.0 || source_ticks < used_ticks {
            return Err(invalid(
                "new duration does not cover this clip; shorten the clip before applying these variables",
            ));
        }
        element["sourceDuration"] = json!(source_ticks as i64);
        element["trimEnd"] = json!((source_ticks - used_ticks).round() as i64);
        let shared = self.scenes()?.iter().any(|scene| {
            crate::classic::tracks(scene).is_ok_and(|tracks| {
                tracks.iter().any(|track| {
                    track["elements"].as_array().unwrap().iter().any(|e| {
                        e["id"] != element_id && e["params"]["hyperframesAssetId"] == old_id
                    })
                })
            })
        });
        let id = if shared {
            let base = format!("hyperframes-{}", source.fingerprint());
            let existing = self.compositions()?;
            let mut id = base.clone();
            let mut suffix = 1;
            while existing.contains_key(&id) {
                id = format!("{base}-{suffix}");
                suffix += 1;
            }
            id
        } else {
            old_id
        };
        element["params"]["hyperframesAssetId"] = json!(id);
        composition.source = source.into();
        composition.duration_seconds = manifest.duration_seconds;
        composition.runtime_manifest = Some(manifest);
        composition.validate()?;
        self.document
            .compositions
            .get_or_insert_default()
            .insert(id, composition.into());
        let scene = self
            .document
            .get_mut("scenes")
            .and_then(Value::as_array_mut)
            .unwrap()
            .iter_mut()
            .find(|s| s["id"] == scene_id)
            .unwrap();
        for track in scene["tracks"]["overlay"].as_array_mut().unwrap() {
            if let Some(target) = track["elements"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|e| e["id"] == element_id)
            {
                *target = element;
                return Ok(());
            }
        }
        Err(invalid("graphic track is missing"))
    }
}
