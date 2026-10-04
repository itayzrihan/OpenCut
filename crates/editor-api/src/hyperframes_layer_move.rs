//! Canonical source planning and commit for moving a timed layer. The host's
//! pinned GSAP compiler rewrites script bodies; Rust owns targets, HTML, bounds,
//! revisions, validation and history. Imported directory contents are never used.
use crate::{
    ClassicProject, HyperframesLayerKind, HyperframesRuntimeManifest, HyperframesSource,
    HyperframesSourceResolution, ModelError, inspect_hyperframes, read_hyperframes_layer_source,
};
use html5gum::{DefaultEmitter, Token, Tokenizer};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesMoveScript {
    pub key: String,
    pub file: String,
    pub content: String,
    /// Inline script body in the planned HTML; None denotes a linked JS file.
    pub start_byte: Option<usize>,
    pub end_byte: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesLayerMovePlan {
    pub source_fingerprint: String,
    pub layer_key: String,
    pub file: String,
    pub element_id: String,
    pub start_seconds: f64,
    pub duration_seconds: f64,
    pub delta_seconds: f64,
    pub local_start_seconds: f64,
    pub local_end_seconds: Option<f64>,
    pub html: String,
    pub scripts: Vec<HyperframesMoveScript>,
}

fn invalid(message: &str) -> ModelError {
    ModelError::Invalid(format!("HyperFrames layer move: {message}"))
}

fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
}

pub fn plan_hyperframes_layer_move(
    source: &HyperframesSource,
    manifest: &HyperframesRuntimeManifest,
    layer_key: &str,
    start_seconds: f64,
) -> Result<HyperframesLayerMovePlan, ModelError> {
    let location = read_hyperframes_layer_source(source, manifest, layer_key)?;
    if location.resolution != HyperframesSourceResolution::Located
        || location.reported_occurrences != 1
    {
        return Err(invalid(
            "this layer needs a unique authored source; edit its source file instead",
        ));
    }
    let layer = manifest
        .layers
        .iter()
        .find(|layer| layer.key == layer_key)
        .unwrap();
    if layer.kind == HyperframesLayerKind::Composition
        || manifest
            .layers
            .iter()
            .any(|other| other.parent_key.as_deref() == Some(layer_key))
    {
        return Err(invalid(
            "moving a group requires its nested timing to be handled together",
        ));
    }
    if !start_seconds.is_finite()
        || start_seconds < 0.0
        || start_seconds + layer.duration_seconds > manifest.duration_seconds + 1e-6
    {
        return Err(invalid("the layer must stay within the source composition"));
    }
    let mut parent = layer.parent_key.as_deref();
    while let Some(key) = parent {
        let ancestor = manifest
            .layers
            .iter()
            .find(|other| other.key == key)
            .unwrap();
        if start_seconds < ancestor.start_seconds - 1e-6
            || start_seconds + layer.duration_seconds
                > ancestor.start_seconds + ancestor.duration_seconds + 1e-6
        {
            return Err(invalid("the layer must stay within its parent time range"));
        }
        parent = ancestor.parent_key.as_deref();
    }
    let file = location.file.unwrap();
    let element_id = location.element_id.unwrap();
    if file != source.entry_file {
        return Err(invalid(
            "moving a layer from a nested source requires composition clock support; edit its source instead",
        ));
    }
    let document = scraper::Html::parse_document(&source.files[&file]);
    let authored = document
        .select(&scraper::Selector::parse("[id], [data-hf-id]").unwrap())
        .find(|element| {
            element.value().attr("id") == Some(&element_id)
                || element.value().attr("data-hf-id") == Some(&element_id)
        })
        .ok_or_else(|| invalid("the authored element cannot be addressed"))?;
    let mut composition_depth = 0;
    for ancestor in authored.ancestors().filter_map(scraper::ElementRef::wrap) {
        if ancestor.value().name() == "template" {
            return Err(invalid(
                "template layer timing requires composition clock support",
            ));
        }
        if ancestor.value().attr("data-composition-id").is_some() {
            composition_depth += 1;
        }
    }
    if composition_depth > 1 {
        return Err(invalid(
            "nested composition timing requires composition clock support",
        ));
    }
    if authored
        .descendants()
        .filter_map(scraper::ElementRef::wrap)
        .any(|element| {
            matches!(
                element.value().name().to_ascii_lowercase().as_str(),
                "animate" | "animatemotion" | "animatetransform" | "set"
            )
        })
    {
        return Err(invalid("SVG animation clocks require source editing"));
    }
    let inspection = inspect_hyperframes(source)?;
    if inspection
        .elements
        .iter()
        .filter(|element| {
            element.file == file && element.element_id.as_deref() == Some(&element_id)
        })
        .count()
        != 1
    {
        return Err(invalid(
            "the authored element is reused or cannot be uniquely addressed",
        ));
    }
    let range = location.location.unwrap();
    let original = &source.files[&file];
    let mut emitter = DefaultEmitter::<usize>::new_with_span();
    emitter.naively_switch_states(true);
    let tag = Tokenizer::new_with_emitter(&original[range.start_byte..range.end_byte], emitter)
        .filter_map(|token| match token.unwrap() {
            Token::StartTag(tag) => Some(tag),
            _ => None,
        })
        .next()
        .unwrap();
    let mut attributes: BTreeMap<String, String> = tag
        .attributes
        .iter()
        .map(|(name, value)| {
            (
                String::from_utf8_lossy(name).into_owned(),
                String::from_utf8_lossy(value).into_owned(),
            )
        })
        .collect();
    let numeric = |name: &str| {
        attributes
            .get(name)
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite())
    };
    let local_start = numeric("data-start")
        .ok_or_else(|| invalid("the layer needs a numeric authored data-start"))?;
    // Inferred/expression durations may depend on another layer or the old start.
    let authored_duration = numeric("data-duration")
        .or_else(|| numeric("data-end").map(|end| end - local_start))
        .ok_or_else(|| invalid("the layer needs a numeric authored duration or end"))?;
    for name in ["data-duration", "data-end"] {
        if attributes.contains_key(name) && numeric(name).is_none() {
            return Err(invalid("timing expressions require source editing"));
        }
    }
    if numeric("data-end").is_some_and(|end| (end - local_start - authored_duration).abs() > 1e-6) {
        return Err(invalid("the authored duration and end disagree"));
    }
    if (authored_duration - layer.duration_seconds).abs() > 1e-6 {
        return Err(invalid(
            "the authored and runtime durations differ; refresh or edit the source",
        ));
    }
    let delta = start_seconds - layer.start_seconds;
    if (delta * 1000.0 - (delta * 1000.0).round()).abs() > 1e-6 {
        return Err(invalid("layer moves currently use millisecond precision"));
    }
    if local_start + delta < 0.0 {
        return Err(invalid(
            "the layer cannot start before its local composition",
        ));
    }
    attributes.insert("data-start".into(), (local_start + delta).to_string());
    if attributes.contains_key("data-end") {
        attributes.insert(
            "data-end".into(),
            (local_start + delta + authored_duration).to_string(),
        );
    }
    let mut opening = format!("<{}", String::from_utf8_lossy(&tag.name));
    for (name, value) in attributes {
        opening.push_str(&format!(" {name}=\"{}\"", escape_attribute(&value)));
    }
    opening.push_str(if tag.self_closing { "/>" } else { ">" });
    let mut html = original.clone();
    html.replace_range(range.start_byte..range.end_byte, &opening);
    let scripts = source_scripts(source, &file, &html)?;
    Ok(HyperframesLayerMovePlan {
        source_fingerprint: source.fingerprint(),
        layer_key: layer_key.into(),
        file,
        element_id,
        start_seconds,
        duration_seconds: layer.duration_seconds,
        delta_seconds: delta,
        local_start_seconds: local_start + delta,
        local_end_seconds: tag
            .attributes
            .contains_key(b"data-end".as_slice())
            .then_some(local_start + delta + authored_duration),
        html,
        scripts,
    })
}

fn source_scripts(
    source: &HyperframesSource,
    file: &str,
    html: &str,
) -> Result<Vec<HyperframesMoveScript>, ModelError> {
    let mut emitter = DefaultEmitter::<usize>::new_with_span();
    emitter.naively_switch_states(true);
    let mut scripts = Vec::new();
    let mut inline_start = None;
    for token in Tokenizer::new_with_emitter(html, emitter) {
        match token.unwrap() {
            Token::StartTag(tag) if tag.name.as_ref() == b"script" => {
                let script_type = tag
                    .attributes
                    .get(b"type".as_slice())
                    .map(|value| String::from_utf8_lossy(value).trim().to_ascii_lowercase())
                    .unwrap_or_default();
                if ![
                    "",
                    "text/javascript",
                    "application/javascript",
                    "application/ecmascript",
                    "application/x-ecmascript",
                    "application/x-javascript",
                    "text/ecmascript",
                    "text/javascript1.0",
                    "text/javascript1.1",
                    "text/javascript1.2",
                    "text/javascript1.3",
                    "text/javascript1.4",
                    "text/javascript1.5",
                    "text/jscript",
                    "text/livescript",
                    "text/x-ecmascript",
                    "text/x-javascript",
                ]
                .contains(&script_type.as_str())
                {
                    if script_type == "module" {
                        return Err(invalid(
                            "module scripts require a module-aware timing compiler",
                        ));
                    }
                    continue;
                }
                if let Some(reference) = tag.attributes.get(b"src".as_slice()) {
                    let path = crate::hyperframes::resolve_reference(
                        file,
                        &String::from_utf8_lossy(reference),
                    )?
                    .ok_or_else(|| {
                        invalid("external scripts must be imported before moving a layer")
                    })?;
                    let content = source
                        .files
                        .get(&path)
                        .ok_or_else(|| invalid("script source is unavailable"))?;
                    if !scripts
                        .iter()
                        .any(|script: &HyperframesMoveScript| script.key == path)
                    {
                        scripts.push(HyperframesMoveScript {
                            key: path.clone(),
                            file: path,
                            content: content.clone(),
                            start_byte: None,
                            end_byte: None,
                        });
                    }
                } else {
                    inline_start = Some(tag.span.end);
                }
            }
            Token::EndTag(tag) if tag.name.as_ref() == b"script" => {
                if let Some(start) = inline_start.take() {
                    scripts.push(HyperframesMoveScript {
                        key: format!("{file}#script:{start}"),
                        file: file.into(),
                        content: html[start..tag.span.start].into(),
                        start_byte: Some(start),
                        end_byte: Some(tag.span.start),
                    });
                }
            }
            _ => {}
        }
    }
    if let Some(start) = inline_start {
        scripts.push(HyperframesMoveScript {
            key: format!("{file}#script:{start}"),
            file: file.into(),
            content: html[start..].into(),
            start_byte: Some(start),
            end_byte: Some(html.len()),
        });
    }
    if scripts.len() > crate::hyperframes::MAX_FILES {
        return Err(invalid("too many animation scripts"));
    }
    Ok(scripts)
}

pub fn prepare_hyperframes_layer_move(
    source: &HyperframesSource,
    manifest: &HyperframesRuntimeManifest,
    layer_key: &str,
    start_seconds: f64,
    scripts: &BTreeMap<String, String>,
) -> Result<HyperframesSource, ModelError> {
    if scripts.values().map(String::len).sum::<usize>() > crate::hyperframes::MAX_SOURCE_BYTES {
        return Err(invalid("compiled scripts exceed the source size limit"));
    }
    let plan = plan_hyperframes_layer_move(source, manifest, layer_key, start_seconds)?;
    if scripts.len() != plan.scripts.len()
        || scripts
            .keys()
            .any(|key| !plan.scripts.iter().any(|script| &script.key == key))
    {
        return Err(invalid("compiler must return exactly the planned scripts"));
    }
    let mut next = source.clone();
    let mut html = plan.html;
    for script in plan.scripts.iter().rev() {
        let Some(updated) = scripts
            .get(&script.key)
            .filter(|updated| *updated != &script.content)
        else {
            continue;
        };
        if let Some(start) = script.start_byte {
            // A script-body result must remain a script body when embedded.
            if updated.to_ascii_lowercase().contains("</script") {
                return Err(invalid(
                    "compiled inline script contains a closing script tag",
                ));
            }
            html.replace_range(start..script.end_byte.unwrap(), updated);
        } else {
            for (file, contents) in &source.files {
                if file == &plan.file || !(file.ends_with(".html") || file.ends_with(".htm")) {
                    continue;
                }
                let document = scraper::Html::parse_document(contents);
                for tag in document.select(&scraper::Selector::parse("script[src]").unwrap()) {
                    if crate::hyperframes::resolve_reference(
                        file,
                        tag.value().attr("src").unwrap(),
                    )?
                    .as_deref()
                        == Some(&script.file)
                    {
                        return Err(invalid(
                            "this animation script is shared by other source files",
                        ));
                    }
                }
            }
            next.files.insert(script.file.clone(), updated.clone());
        }
    }
    next.files.insert(plan.file, html);
    inspect_hyperframes(&next)?;
    Ok(next)
}

impl ClassicProject {
    pub fn move_hyperframes_layer(
        &mut self,
        target: (&str, &str),
        layer_key: &str,
        start_seconds: f64,
        source_fingerprint: &str,
        scripts: &BTreeMap<String, String>,
        manifest: HyperframesRuntimeManifest,
    ) -> Result<(), ModelError> {
        let (scene_id, element_id) = target;
        let (_, composition, _) = self.hyperframes_clip_composition(scene_id, element_id)?;
        if composition.source.fingerprint() != source_fingerprint {
            return Err(invalid("source changed while moving the layer"));
        }
        let original = composition
            .runtime_manifest
            .as_ref()
            .ok_or_else(|| invalid("refresh the layer inventory first"))?;
        let plan =
            plan_hyperframes_layer_move(&composition.source, original, layer_key, start_seconds)?;
        let source = prepare_hyperframes_layer_move(
            &composition.source,
            original,
            layer_key,
            start_seconds,
            scripts,
        )?;
        manifest.validate(&source)?;
        if original.layers.len() != manifest.layers.len()
            || (original.duration_seconds - manifest.duration_seconds).abs() > 1e-6
        {
            return Err(invalid(
                "moving one layer changed the composition duration or layer count",
            ));
        }
        let resulting: BTreeMap<_, _> = manifest
            .layers
            .iter()
            .map(|layer| (&layer.key, layer))
            .collect();
        for before in &original.layers {
            let after = resulting
                .get(&before.key)
                .ok_or_else(|| invalid("runtime preflight changed a layer identity"))?;
            let mut expected = before.clone();
            if before.key == layer_key {
                expected.start_seconds = start_seconds;
                if let Some(media) = &mut expected.media {
                    media
                        .attributes
                        .insert("data-start".into(), plan.local_start_seconds.to_string());
                    if let Some(end) = plan.local_end_seconds {
                        media.attributes.insert("data-end".into(), end.to_string());
                    }
                }
            }
            if (expected.start_seconds - after.start_seconds).abs() > 1e-6 {
                return Err(invalid(
                    "runtime preflight did not move the requested layer",
                ));
            }
            expected.start_seconds = after.start_seconds;
            if expected != **after {
                return Err(invalid(
                    "runtime preflight did not preserve the requested layer timing and other layers",
                ));
            }
        }
        self.replace_hyperframes_clip_source(scene_id, element_id, source, manifest)
    }
}
