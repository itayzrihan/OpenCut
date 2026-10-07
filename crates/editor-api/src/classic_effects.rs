//! Host renderer descriptions, not a second project state. The product publishes
//! its live effect registry here; every edit still changes EditorDocument.
use crate::CapabilityError;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, RwLock};

#[derive(Clone, Default)]
pub struct ClassicEffectCatalog(pub(crate) Arc<RwLock<CatalogSnapshot>>);

#[derive(Clone, Default, Serialize)]
pub(crate) struct CatalogSnapshot {
    pub revision: String,
    pub definitions: Vec<Value>,
}

pub(crate) fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}

pub(crate) fn validate_params(params: &Map<String, Value>) -> Result<(), CapabilityError> {
    if params.len() > 512
        || params.iter().any(|(key, value)| {
            key.is_empty() || !(value.is_number() || value.is_string() || value.is_boolean())
        })
    {
        return Err(invalid(
            "effect parameters must be named number, string or boolean values",
        ));
    }
    Ok(())
}

impl ClassicEffectCatalog {
    /// Trusted host API, intentionally absent from the model/MCP tool surface.
    /// Renderer functions never cross this boundary. Replacement is atomic.
    pub fn replace(&self, definitions: Vec<Value>) -> Result<String, CapabilityError> {
        let bytes = serde_json::to_vec(&definitions).map_err(|e| invalid(&e.to_string()))?;
        if definitions.len() > 512 || bytes.len() > 2_097_152 {
            return Err(invalid("effect catalog exceeds host metadata limits"));
        }
        let mut types = std::collections::HashSet::new();
        for definition in &definitions {
            let kind = definition["type"]
                .as_str()
                .filter(|v| !v.is_empty() && v.len() <= 256)
                .ok_or_else(|| invalid("effect definition requires a type"))?;
            if !types.insert(kind) || definition["name"].as_str().is_none_or(str::is_empty) {
                return Err(invalid("effect types must be unique and names nonempty"));
            }
            let params = definition["params"]
                .as_array()
                .filter(|p| p.len() <= 512)
                .ok_or_else(|| invalid("effect definition requires parameter descriptions"))?;
            let mut defaults = Map::new();
            for param in params {
                let key = param["key"]
                    .as_str()
                    .ok_or_else(|| invalid("effect parameter requires a key"))?;
                if param["type"].as_str().is_none()
                    || defaults
                        .insert(key.into(), param["default"].clone())
                        .is_some()
                {
                    return Err(invalid(
                        "effect parameter descriptions require unique keys and types",
                    ));
                }
            }
            validate_params(&defaults)?;
        }
        let mut catalog = self
            .0
            .write()
            .map_err(|_| invalid("effect catalog lock poisoned"))?;
        catalog.definitions = definitions;
        // A checkpoint must not confuse a fresh host's first catalog with
        // different definitions that happened to have the same counter.
        catalog.revision = format!("{:x}", Sha256::digest(&bytes));
        Ok(catalog.revision.clone())
    }
}

pub(crate) fn normalize_type(value: &str) -> String {
    let mut normalized = String::new();
    let mut separator = false;
    for c in value.trim().to_lowercase().chars() {
        if c.is_whitespace() || c == '_' {
            if !separator {
                normalized.push('-');
            }
            separator = true;
        } else {
            normalized.push(c);
            separator = false;
        }
    }
    if normalized == "blurzoom"
        || normalized
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .any(|part| part == "blur")
    {
        "blur".into()
    } else {
        normalized
    }
}

pub(crate) fn build_effect(
    catalog: &CatalogSnapshot,
    requested: &str,
    overrides: &Map<String, Value>,
    allow_custom: bool,
) -> Result<Value, CapabilityError> {
    validate_params(overrides)?;
    let normalized = normalize_type(requested);
    let known = catalog.definitions.iter().find(|d| d["type"] == normalized);
    let definition = known.or_else(|| allow_custom.then(|| catalog.definitions.iter().find(|d| d["type"] == "custom-ai-effect")).flatten())
        .ok_or_else(|| CapabilityError::Unavailable("Effect is not in the host renderer catalog. Read effects.classic.catalog.read; custom fallback must be explicit and does not prove a visible result.".into()))?;
    let mut params: Map<String, Value> = definition["params"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["key"].as_str().unwrap().into(), p["default"].clone()))
        .collect();
    if known.is_none() {
        let trimmed = requested.trim();
        let label = if trimmed.is_empty() {
            "Custom AI edit"
        } else {
            trimmed
        };
        let kind = if trimmed.is_empty() {
            "custom"
        } else {
            trimmed
        };
        // Keep the existing Classic fallback's stable, pretty-printed spec.
        params.extend(json!({"label":label,"kind":"effect","requestedType":kind,"intent":label,
            "specJson":serde_json::to_string_pretty(&json!({"type":kind,"kind":"effect","intent":label})).unwrap()
        }).as_object().unwrap().clone());
    }
    params.extend(overrides.clone());
    Ok(json!({"type":definition["type"], "params":params, "enabled":true}))
}

/// Validate known effect envelope fields while retaining extension metadata.
pub(crate) fn validate_effects(element: &Value) -> Result<(), CapabilityError> {
    let Some(effects) = element.get("effects").filter(|v| !v.is_null()) else {
        return Ok(());
    };
    let effects = effects
        .as_array()
        .ok_or_else(|| invalid("effects must be an array"))?;
    let mut ids = std::collections::HashSet::new();
    for effect in effects {
        let id = effect["id"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| invalid("effect ID required"))?;
        if !ids.insert(id)
            || effect["type"].as_str().is_none_or(str::is_empty)
            || effect
                .get("enabled")
                .is_some_and(|value| !value.is_null() && !value.is_boolean())
            || !effect["params"].is_object()
        {
            return Err(invalid("invalid or duplicate effect envelope"));
        }
    }
    Ok(())
}
