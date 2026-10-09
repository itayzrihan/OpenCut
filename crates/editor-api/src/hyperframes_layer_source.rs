//! Source navigation only. A matching authored tag is not proof that a runtime
//! occurrence can be independently retimed: scripts and nested hosts may share it.
use crate::{HyperframesLayerKind, HyperframesRuntimeManifest, HyperframesSource, ModelError};
use html5gum::{DefaultEmitter, Token, Tokenizer};
use schemars::JsonSchema;
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesSourceLocation {
    /// Raw UTF-8 byte offsets, including the complete opening tag.
    pub start_byte: usize,
    pub end_byte: usize,
    /// Offsets in a textarea's value (UTF-16, CRLF/CR normalized to LF).
    pub start_textarea: usize,
    pub end_textarea: usize,
    /// One-based line and UTF-16 column in the displayed source.
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HyperframesSourceResolution {
    Located,
    Ambiguous,
    Unresolved,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesLayerSource {
    pub source_fingerprint: String,
    pub layer_key: String,
    pub file: Option<String>,
    pub element_id: Option<String>,
    pub resolution: HyperframesSourceResolution,
    pub location: Option<HyperframesSourceLocation>,
    pub tag: Option<String>,
    /// Observed layers using this tag, including this occurrence. A lower bound
    /// on uses of the source: scripts may also clone or reference it.
    pub reported_occurrences: usize,
}

pub fn read_hyperframes_layer_source(
    source: &HyperframesSource,
    manifest: &HyperframesRuntimeManifest,
    layer_key: &str,
) -> Result<HyperframesLayerSource, ModelError> {
    manifest.validate(source)?;
    let layer = manifest
        .layers
        .iter()
        .find(|layer| layer.key == layer_key)
        .ok_or_else(|| ModelError::Invalid("HyperFrames source layer does not exist".into()))?;
    let mut result = HyperframesLayerSource {
        source_fingerprint: manifest.source_fingerprint.clone(),
        layer_key: layer.key.clone(),
        file: layer.file.clone(),
        element_id: layer.element_id.clone(),
        resolution: HyperframesSourceResolution::Unresolved,
        location: None,
        tag: None,
        reported_occurrences: 0,
    };
    let Some((file, id)) = layer.file.as_deref().zip(layer.element_id.as_deref()) else {
        return Ok(result);
    };
    if id.is_empty()
        || !layer.key.starts_with("dom/")
        || !(file.to_ascii_lowercase().ends_with(".html")
            || file.to_ascii_lowercase().ends_with(".htm"))
    {
        return Ok(result);
    }
    let html = &source.files[file];
    let identity_attributes: &[&str] = if layer.kind == HyperframesLayerKind::Composition {
        &["id", "data-hf-id", "data-composition-id"]
    } else {
        &["id", "data-hf-id"]
    };
    let mut emitter = DefaultEmitter::<usize>::new_with_span();
    // Skip raw script/style/textarea contents, including strings containing tags.
    emitter.naively_switch_states(true);
    let mut candidate = None;
    for token in Tokenizer::new_with_emitter(html.as_str(), emitter) {
        let Token::StartTag(tag) = token.unwrap() else {
            continue;
        };
        if !identity_attributes.iter().any(|attribute| {
            tag.attributes
                .get(attribute.as_bytes())
                .is_some_and(|value| value.as_ref() == id.as_bytes())
        }) {
            continue;
        }
        if candidate.is_some() {
            result.resolution = HyperframesSourceResolution::Ambiguous;
            return Ok(result);
        }
        candidate = Some(tag);
    }
    let Some(candidate) = candidate else {
        return Ok(result);
    };
    // A tokenizer does not perform HTML tree construction. Cross-check against
    // the parsed document, rejecting inert template contents and discarded tags.
    let document = Html::parse_document(html);
    let selector = Selector::parse("[id], [data-hf-id], [data-composition-id]").unwrap();
    let mut matches = document.select(&selector).filter(|element| {
        identity_attributes
            .iter()
            .any(|attribute| element.value().attr(attribute) == Some(id))
            && !element
                .ancestors()
                .filter_map(ElementRef::wrap)
                .any(|ancestor| {
                    ancestor.value().name() == "template" && !is_composition_template(ancestor)
                })
    });
    let Some(element) = matches.next() else {
        return Ok(result);
    };
    if matches.next().is_some() {
        result.resolution = HyperframesSourceResolution::Ambiguous;
        return Ok(result);
    }
    // HTML tree construction restores SVG camelCase and namespaces. Index the
    // qualified names once, avoiding a quadratic scan on tags with many attrs.
    let parsed_attributes: BTreeMap<String, &[u8]> = element
        .value()
        .attrs
        .iter()
        .map(|(name, value)| {
            let qualified_name = match name.prefix.as_deref() {
                Some(prefix) => format!("{prefix}:{}", name.local),
                None => name.local.to_string(),
            };
            (qualified_name.to_ascii_lowercase(), &value.as_bytes()[..])
        })
        .collect();
    if !candidate
        .name
        .eq_ignore_ascii_case(element.value().name().as_bytes())
        || !candidate.attributes.iter().all(|(name, value)| {
            parsed_attributes.get(String::from_utf8_lossy(name).as_ref()) == Some(&value.as_ref())
        })
    {
        return Ok(result);
    }
    let start = candidate.span.start;
    let end = candidate.span.end;
    let Some(prefix) = html.get(..start) else {
        return Ok(result);
    };
    let Some(opening) = html.get(start..end) else {
        return Ok(result);
    };
    let prefix = normalize_newlines(prefix);
    let opening = normalize_newlines(opening);
    let start_textarea = prefix.encode_utf16().count();
    result.resolution = HyperframesSourceResolution::Located;
    result.location = Some(HyperframesSourceLocation {
        start_byte: start,
        end_byte: end,
        start_textarea,
        end_textarea: start_textarea + opening.encode_utf16().count(),
        line: prefix.bytes().filter(|byte| *byte == b'\n').count() + 1,
        column: prefix
            .rsplit('\n')
            .next()
            .unwrap_or_default()
            .encode_utf16()
            .count()
            + 1,
    });
    result.tag = Some(element.value().name().to_owned());
    result.reported_occurrences = manifest
        .layers
        .iter()
        .filter(|other| {
            other.file == layer.file
                && other.element_id.as_deref().is_some_and(|other_id| {
                    identity_attributes
                        .iter()
                        .any(|attribute| element.value().attr(attribute) == Some(other_id))
                })
        })
        .count();
    Ok(result)
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn is_composition_template(element: ElementRef<'_>) -> bool {
    // HyperFrames mounts composition templates. Plain clone templates remain
    // unresolved because their live identities can be generated by scripts.
    element.value().attr("data-composition-id").is_some()
        || element
            .first_child()
            .into_iter()
            .flat_map(|fragment| fragment.children())
            .filter_map(ElementRef::wrap)
            .any(|child| child.value().attr("data-composition-id").is_some())
}
