//! Serializable product mask definitions. No editor state or renderer code lives here.
use crate::CapabilityError;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, RwLock};

#[derive(Clone, Default)]
pub struct ClassicMaskCatalog(pub(crate) Arc<RwLock<MaskCatalogSnapshot>>);
#[derive(Clone, Default, Serialize)]
pub(crate) struct MaskCatalogSnapshot {
    pub revision: String,
    pub definitions: Vec<Value>,
}
fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}

impl ClassicMaskCatalog {
    /// Host-only atomic metadata publication, never a model tool.
    pub fn replace(&self, definitions: Vec<Value>) -> Result<String, CapabilityError> {
        let bytes = serde_json::to_vec(&definitions).map_err(|e| invalid(&e.to_string()))?;
        if definitions.len() > 512 || bytes.len() > 2_097_152 {
            return Err(invalid("mask catalog exceeds metadata limits"));
        }
        let mut types = std::collections::HashSet::new();
        for d in &definitions {
            let kind = d["type"]
                .as_str()
                .filter(|v| !v.is_empty() && v.len() <= 256)
                .ok_or_else(|| invalid("mask type missing"))?;
            if !types.insert(kind) || d["name"].as_str().is_none_or(str::is_empty) {
                return Err(invalid("mask types must be unique and names nonempty"));
            }
            if !matches!(
                d["defaultSizing"].as_str(),
                Some("fixed" | "square" | "diagonal")
            ) {
                return Err(invalid("unsupported mask default sizing"));
            }
            let defaults = d["defaults"]
                .as_object()
                .ok_or_else(|| invalid("mask defaults missing"))?;
            bounded_params(defaults)?;
            let params = d["params"]
                .as_array()
                .filter(|v| v.len() <= 512)
                .ok_or_else(|| invalid("mask parameter descriptions missing"))?;
            let mut keys = std::collections::HashSet::new();
            for p in params {
                let key = p["key"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| invalid("mask parameter key missing"))?;
                if !keys.insert(key) || p["type"].as_str().is_none() {
                    return Err(invalid(
                        "mask parameter keys must be unique with declared types",
                    ));
                }
            }
            if d["defaultSizing"] == "square"
                && defaults.get("width").and_then(Value::as_f64).is_none()
            {
                return Err(invalid("square mask defaults require a width ratio"));
            }
        }
        let mut snapshot = self
            .0
            .write()
            .map_err(|_| invalid("mask catalog lock poisoned"))?;
        snapshot.revision = format!("{:x}", Sha256::digest(&bytes));
        snapshot.definitions = definitions;
        Ok(snapshot.revision.clone())
    }
}

fn bounded_params(params: &Map<String, Value>) -> Result<(), CapabilityError> {
    if params.len() > 512
        || params.keys().any(|k| k.is_empty())
        || serde_json::to_vec(params)
            .map_err(|e| invalid(&e.to_string()))?
            .len()
            > 1_048_576
    {
        return Err(invalid("mask parameters exceed limits"));
    }
    Ok(())
}
pub(crate) fn definition<'a>(
    catalog: &'a MaskCatalogSnapshot,
    kind: &str,
) -> Result<&'a Value, CapabilityError> {
    catalog
        .definitions
        .iter()
        .find(|d| d["type"] == kind)
        .ok_or_else(|| {
            CapabilityError::Unavailable(
                "Mask renderer is not declared by this host; read masks.classic.catalog.read"
                    .into(),
            )
        })
}
pub(crate) fn validate_update(
    definition: &Value,
    params: &Map<String, Value>,
) -> Result<(), CapabilityError> {
    bounded_params(params)?;
    let defaults = definition["defaults"].as_object().unwrap();
    for (key, value) in params {
        let sample = defaults
            .get(key)
            .or_else(|| {
                definition["params"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|p| p["key"] == *key)
                    .and_then(|p| p.get("default"))
            })
            .ok_or_else(|| {
                invalid(&format!(
                    "mask parameter {key} is not declared by the product"
                ))
            })?;
        let valid = match sample {
            Value::Number(_) => value.as_f64().is_some_and(f64::is_finite),
            Value::Bool(_) => value.is_boolean(),
            Value::String(_) => value.is_string(),
            Value::Array(_) => value.is_array(),
            Value::Object(_) => value.is_object(),
            Value::Null => value.is_null(),
        };
        if !valid {
            return Err(invalid(&format!("invalid type for mask parameter {key}")));
        }
        if let Some(options) = definition["params"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["key"] == *key && p["type"] == "select")
            .and_then(|p| p["options"].as_array())
        {
            if !options.iter().any(|o| o["value"] == *value) {
                return Err(invalid(&format!("invalid choice for mask parameter {key}")));
            }
        }
    }
    Ok(())
}
pub(crate) fn build(
    catalog: &MaskCatalogSnapshot,
    kind: &str,
    size: Option<(f64, f64)>,
    overrides: &Map<String, Value>,
) -> Result<Value, CapabilityError> {
    let d = definition(catalog, kind)?;
    validate_update(d, overrides)?;
    let mut params = d["defaults"].as_object().unwrap().clone();
    let (w, h) = size.unwrap_or((0.0, 0.0));
    if !w.is_finite() || !h.is_finite() {
        return Err(invalid("mask element size must be finite"));
    }
    let (w, h) = (w.abs(), h.abs());
    match d["defaultSizing"].as_str().unwrap() {
        "square" => {
            let ratio = params["width"].as_f64().unwrap();
            let side = w.min(h) * ratio;
            params.insert(
                "width".into(),
                json!(if w > 0.0 { side / w } else { ratio }),
            );
            params.insert(
                "height".into(),
                json!(if h > 0.0 { side / h } else { ratio }),
            );
        }
        "diagonal" => {
            let diagonal = if w > 0.0 && h > 0.0 {
                (w * w + h * h).sqrt()
            } else {
                0.0
            };
            let width = if w > 0.0 {
                diagonal / w
            } else {
                std::f64::consts::SQRT_2
            };
            if !width.is_finite() {
                return Err(invalid("mask size overflow"));
            }
            params.insert("width".into(), json!(width.max(1.0)));
        }
        _ => {}
    }
    params.extend(overrides.clone());
    validate_update(d, &params)?;
    Ok(json!({"type":kind,"params":params}))
}
