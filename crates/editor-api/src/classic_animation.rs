//! Product parameter metadata for Classic animation. This is a host-owned
//! catalog, never another project document or an agent-maintained path list.
use crate::CapabilityError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::{Arc, RwLock},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum AnimationTargetSelector {
    Element {
        #[serde(rename = "elementType")]
        element_type: String,
        #[serde(rename = "definitionId")]
        definition_id: Option<String>,
        #[serde(rename = "paramKind")]
        param_kind: Option<String>,
        #[serde(rename = "pathPrefix")]
        path_prefix: String,
    },
    Effect {
        #[serde(rename = "effectType")]
        effect_type: String,
        #[serde(rename = "elementTypes")]
        element_types: Vec<String>,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClassicAnimationGroup {
    pub target: AnimationTargetSelector,
    /// Product ParamDefinition plus a serializable channelLayout description.
    /// Executable read/write/compose/decompose functions never cross this API.
    pub params: Vec<Value>,
}

#[derive(Clone, Default)]
pub struct ClassicAnimationCatalog(pub(crate) Arc<RwLock<AnimationCatalogSnapshot>>);

#[derive(Clone, Default)]
pub(crate) struct AnimationCatalogSnapshot {
    pub revision: String,
    pub groups: Vec<ClassicAnimationGroup>,
}

fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512
}

impl ClassicAnimationCatalog {
    /// Trusted host API only; replacements are validated before publication.
    pub fn replace(&self, groups: Vec<ClassicAnimationGroup>) -> Result<String, CapabilityError> {
        let bytes = serde_json::to_vec(&groups).map_err(|e| invalid(&e.to_string()))?;
        if groups.len() > 2048 || bytes.len() > 8_388_608 {
            return Err(invalid("animation catalog exceeds metadata limits"));
        }
        let mut selectors = HashSet::new();
        for group in &groups {
            let selector = serde_json::to_string(&group.target).unwrap();
            if !selectors.insert(selector) || group.params.len() > 512 {
                return Err(invalid(
                    "duplicate animation selector or too many parameters",
                ));
            }
            match &group.target {
                AnimationTargetSelector::Element {
                    element_type,
                    definition_id,
                    param_kind,
                    path_prefix,
                } => {
                    if !identifier(element_type)
                        || definition_id.as_ref().is_some_and(|s| !identifier(s))
                        || param_kind.as_ref().is_some_and(|s| !identifier(s))
                        || !matches!(path_prefix.as_str(), "" | "params.")
                    {
                        return Err(invalid("invalid animation element selector"));
                    }
                }
                AnimationTargetSelector::Effect {
                    effect_type,
                    element_types,
                } if !identifier(effect_type)
                    || element_types.is_empty()
                    || element_types.len() > 128
                    || element_types.iter().any(|v| !identifier(v)) =>
                {
                    return Err(invalid("invalid animation effect selector"));
                }
                _ => {}
            }
            let mut keys = HashSet::new();
            for param in &group.params {
                let key = param["key"]
                    .as_str()
                    .filter(|s| identifier(s))
                    .ok_or_else(|| invalid("animation parameter requires a key"))?;
                if !keys.insert(key)
                    || matches!(key, "bindings" | "channels")
                    || param["label"].as_str().is_none()
                    || !matches!(
                        param["type"].as_str(),
                        Some("number" | "boolean" | "color" | "select" | "text" | "font")
                    )
                    || !(param["default"].is_number()
                        || param["default"].is_string()
                        || param["default"].is_boolean())
                    || param.get("keyframable").is_some_and(|v| !v.is_boolean())
                {
                    return Err(invalid("invalid animation parameter description"));
                }
                let layout = &param["channelLayout"];
                let components = if layout["kind"] == "leaf" {
                    if layout["component"]["key"] != "value" {
                        return Err(invalid("leaf animation component must be value"));
                    }
                    vec![&layout["component"]]
                } else if layout["kind"] == "composite" {
                    layout["components"]
                        .as_array()
                        .filter(|c| !c.is_empty() && c.len() <= 128)
                        .ok_or_else(|| invalid("invalid composite animation layout"))?
                        .iter()
                        .collect()
                } else {
                    return Err(invalid("animation channel layout required"));
                };
                if !matches!(
                    layout["easingMode"].as_str(),
                    Some("independent" | "shared")
                ) {
                    return Err(invalid("invalid animation easing mode"));
                }
                let mut component_keys = HashSet::new();
                for component in components {
                    let key = component["key"]
                        .as_str()
                        .filter(|s| identifier(s))
                        .ok_or_else(|| invalid("animation component requires a key"))?;
                    if !component_keys.insert(key)
                        || !matches!(component["valueKind"].as_str(), Some("scalar" | "discrete"))
                        || !matches!(
                            component["defaultInterpolation"].as_str(),
                            Some("linear" | "hold")
                        )
                    {
                        return Err(invalid("invalid animation channel component"));
                    }
                }
            }
        }
        let revision = format!("{:x}", Sha256::digest(&bytes));
        *self
            .0
            .write()
            .map_err(|_| invalid("animation catalog lock poisoned"))? = AnimationCatalogSnapshot {
            revision: revision.clone(),
            groups,
        };
        Ok(revision)
    }
}

impl AnimationCatalogSnapshot {
    /// Ordered selectors follow the product resolver's precedence. Only targets
    /// on this actual clip are returned; another clip's effects cannot leak in.
    pub(crate) fn targets(&self, element: &Value) -> Vec<Value> {
        let mut paths = HashSet::new();
        let mut result = Vec::new();
        let mut append =
            |group: &ClassicAnimationGroup, prefix: &str, base: &Value, effect_id: Option<&str>| {
                for param in &group.params {
                    if param["keyframable"] == false {
                        continue;
                    }
                    let key = param["key"].as_str().unwrap();
                    let path = format!("{prefix}{key}");
                    if !paths.insert(path.clone()) {
                        continue;
                    }
                    result.push(json!({
                    "propertyPath":path, "parameter":param,
                    "baseValue":base.get(key).filter(|v| !v.is_null()).unwrap_or(&param["default"]),
                    "baseTarget": {"paramKey":key, "effectId":effect_id},
                    "animated":element["animations"].get(&path).is_some_and(|v| !v.is_null())
                }));
                }
            };
        for group in &self.groups {
            match &group.target {
                AnimationTargetSelector::Element {
                    element_type,
                    definition_id,
                    param_kind,
                    path_prefix,
                } => {
                    if element["type"] == *element_type
                        && definition_id
                            .as_ref()
                            .is_none_or(|v| element["definitionId"] == *v)
                        && param_kind
                            .as_ref()
                            .is_none_or(|v| element["params"]["kind"] == *v)
                    {
                        append(group, path_prefix, &element["params"], None);
                    }
                }
                AnimationTargetSelector::Effect {
                    effect_type,
                    element_types,
                } => {
                    if !element_types.iter().any(|t| element["type"] == *t) {
                        continue;
                    }
                    if let Some(effects) = element["effects"].as_array() {
                        for effect in effects.iter().filter(|e| e["type"] == *effect_type) {
                            if let Some(id) = effect["id"].as_str() {
                                append(
                                    group,
                                    &format!("effects.{id}.params."),
                                    &effect["params"],
                                    Some(id),
                                );
                            }
                        }
                    }
                }
            }
        }
        result
    }
}
