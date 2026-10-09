//! Compact Classic history transport. Source text is stored once per content
//! hash; every restored project still owns strong references to its sources.

use crate::{ClassicComposition, ClassicDocument, ClassicProject, HyperframesSource, ModelError};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, sync::Arc};

pub(crate) type SourcePool = BTreeMap<String, Arc<HyperframesSource>>;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchivedClassicProject {
    /// Same project JSON, with each composition's source replaced by its SHA-256
    /// ID in the archive source pool. References are resolved before validation.
    document: Map<String, Value>,
    media_assets: Vec<Map<String, Value>>,
}

/// Version 2 history uses lossless JSON deltas against the archive's current
/// snapshot. Full snapshots remain supported for v1 and for cheaper encodings.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub(crate) enum ArchivedHistorySnapshot {
    Full(ArchivedClassicProject),
    Delta { delta: Vec<Value> },
}

impl ArchivedHistorySnapshot {
    pub(crate) fn encode(
        classic: ArchivedClassicProject,
        base: Option<&Value>,
    ) -> Result<Self, ModelError> {
        let Some(base) = base else {
            return Ok(Self::Full(classic));
        };
        let value = serde_json::to_value(&classic).map_err(|e| invalid(&e.to_string()))?;
        let patch = json_patch::diff(base, &value);
        let delta = serde_json::to_value(patch).map_err(|e| invalid(&e.to_string()))?;
        if serde_json::to_vec(&delta)
            .map_err(|e| invalid(&e.to_string()))?
            .len()
            + 16
            < serde_json::to_vec(&value)
                .map_err(|e| invalid(&e.to_string()))?
                .len()
        {
            Ok(Self::Delta {
                delta: delta.as_array().expect("patch array").clone(),
            })
        } else {
            Ok(Self::Full(classic))
        }
    }

    pub(crate) fn restore(
        self,
        base: Option<&Value>,
        sources: &SourcePool,
        budget: &mut usize,
    ) -> Result<ClassicProject, ModelError> {
        let classic = match self {
            Self::Full(classic) => classic,
            Self::Delta { delta } => {
                let mut value = base
                    .ok_or_else(|| invalid("history delta requires archive version 2"))?
                    .clone();
                let patch: json_patch::Patch = serde_json::from_value(Value::Array(delta))
                    .map_err(|e| invalid(&e.to_string()))?;
                // Our encoder uses only these operations. Copy/move can amplify
                // untrusted data or introduce order-dependent aliasing.
                if patch.0.iter().any(|op| {
                    !matches!(
                        op,
                        json_patch::PatchOperation::Add(_)
                            | json_patch::PatchOperation::Remove(_)
                            | json_patch::PatchOperation::Replace(_)
                    )
                }) {
                    return Err(invalid("unsupported history delta operation"));
                }
                json_patch::patch(&mut value, &patch).map_err(|e| invalid(&e.to_string()))?;
                serde_json::from_value(value).map_err(|e| invalid(&e.to_string()))?
            }
        };
        let bytes = serde_json::to_vec(&classic)
            .map_err(|e| invalid(&e.to_string()))?
            .len();
        *budget = budget
            .checked_sub(bytes)
            .ok_or_else(|| invalid("expanded history exceeds its storage budget"))?;
        classic.restore(sources)
    }
}

impl ClassicProject {
    pub(crate) fn to_archive(&self, sources: &mut SourcePool) -> ArchivedClassicProject {
        let mut document = self.document.fields.clone();
        if let Some(compositions) = &self.document.compositions {
            let archived = compositions
                .iter()
                .map(|(id, composition)| {
                    let source_id = source_key(sources, &composition.source);
                    sources
                        .entry(source_id.clone())
                        .or_insert_with(|| composition.source.clone());
                    let mut properties = composition.properties.clone();
                    properties.insert("source".into(), Value::String(source_id));
                    (id.clone(), Value::Object(properties))
                })
                .collect();
            document.insert("hyperframesCompositions".into(), Value::Object(archived));
        }
        ArchivedClassicProject {
            document,
            media_assets: self.media_assets.clone(),
        }
    }

    pub(crate) fn intern_sources(&mut self, sources: &mut SourcePool) {
        for composition in self
            .document
            .compositions
            .iter_mut()
            .flat_map(|values| values.values_mut())
        {
            let id = source_key(sources, &composition.source);
            composition.source = sources
                .entry(id)
                .or_insert_with(|| composition.source.clone())
                .clone();
        }
    }
}

impl ArchivedClassicProject {
    pub(crate) fn restore(mut self, sources: &SourcePool) -> Result<ClassicProject, ModelError> {
        let compositions = self
            .document
            .remove("hyperframesCompositions")
            .map(|collection| {
                let Value::Object(collection) = collection else {
                    return Err(invalid("composition collection must be an object"));
                };
                collection
                    .into_iter()
                    .map(|(id, value)| {
                        let Value::Object(mut properties) = value else {
                            return Err(invalid("composition must be an object"));
                        };
                        let source_id = properties
                            .remove("source")
                            .and_then(|value| value.as_str().map(str::to_owned))
                            .ok_or_else(|| {
                                invalid("composition source must reference an archive source")
                            })?;
                        let source = sources
                            .get(&source_id)
                            .cloned()
                            .ok_or_else(|| invalid("archive source is missing"))?;
                        Ok((id, ClassicComposition { source, properties }))
                    })
                    .collect::<Result<BTreeMap<_, _>, ModelError>>()
            })
            .transpose()?;
        Ok(ClassicProject {
            document: ClassicDocument {
                fields: self.document,
                compositions,
            },
            media_assets: self.media_assets,
        })
    }
}

pub(crate) fn validate_sources(sources: &SourcePool) -> Result<(), ModelError> {
    for (id, source) in sources {
        source.validate()?;
        if id != &source.fingerprint() {
            return Err(invalid(
                "archive source fingerprint does not match its content",
            ));
        }
    }
    Ok(())
}

fn invalid(message: &str) -> ModelError {
    ModelError::Invalid(format!("Classic archive: {message}"))
}

fn source_key(sources: &SourcePool, source: &Arc<HyperframesSource>) -> String {
    sources
        .iter()
        .find(|(_, existing)| Arc::ptr_eq(existing, source))
        .map(|(id, _)| id.clone())
        .unwrap_or_else(|| source.fingerprint())
}
