use super::*;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    scene_id: String,
    track_id: String,
    element_id: String,
    expected_revision: Option<u64>,
    property_path: Option<String>,
    query: Option<String>,
    #[serde(default)]
    include_parameters: bool,
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    revision: u64,
    catalog_revision: String,
    targets: Vec<Value>,
    total: usize,
    next_offset: Option<usize>,
}

pub(super) fn register_animation_catalog(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    catalog: crate::ClassicAnimationCatalog,
) -> Result<(), RegistryError> {
    register::<Input, Output, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "animation.classic.targets.read",
        "Discover animatable Classic clip parameters",
        "Read exact animatable property paths for an existing clip from the live product registries (element, graphics, effect instances and specialized element kinds). No keyframes need to exist yet. Only parameters supported by the target clip are returned; disabled keyframing parameters are excluded. Includes current base values and whether a path has animation. includeParameters returns product type/default/range/options/dependencies and leaf/composite channel descriptions. propertyPath is an exact literal path; query searches path and label. Paginated (default 50, maximum 100); nextOffset continues the same query. revision and catalogRevision identify the document and host definitions used; expectedRevision rejects stale reads. Describes animation targets, not proof that all editing operations are migrated. Host functions and renderer code are not exposed.",
        "animation",
        AccessLevel::Read,
        false,
        false,
        &[
            "classic",
            "animation",
            "keyframe",
            "parameters",
            "catalog",
            "discovery",
        ],
        move |_, input| {
            let state = state.clone();
            let catalog = catalog.clone();
            async move {
                let invalid = |message: &str| CapabilityError::InvalidInput(message.into());
                let limit = input.limit.unwrap_or(50);
                if !(1..=100).contains(&limit)
                    || input.query.as_ref().is_some_and(|q| q.len() > 1024)
                {
                    return Err(invalid("limit must be 1..100 and query at most 1024 bytes"));
                }
                let state = state.read().map_err(|_| invalid("state lock poisoned"))?;
                if state.active_project_id() != Some(input.project_id.as_str()) {
                    return Err(CapabilityError::Conflict(
                        "animation target project is not active".into(),
                    ));
                }
                let revision = state.document.revision;
                if input.expected_revision.is_some_and(|r| r != revision) {
                    return Err(CapabilityError::Conflict(
                        "animation target revision changed".into(),
                    ));
                }
                let classic = state
                    .document
                    .project
                    .as_ref()
                    .and_then(|p| p.classic.as_ref())
                    .ok_or_else(|| invalid("Classic project required"))?;
                let scene = classic.document["scenes"]
                    .as_array()
                    .and_then(|scenes| scenes.iter().find(|s| s["id"] == input.scene_id))
                    .ok_or_else(|| invalid("animation scene not found"))?;
                let tracks = &scene["tracks"];
                let track = std::iter::once(&tracks["main"])
                    .chain(tracks["overlay"].as_array().into_iter().flatten())
                    .chain(tracks["audio"].as_array().into_iter().flatten())
                    .find(|t| t["id"] == input.track_id)
                    .ok_or_else(|| invalid("animation track not found"))?;
                let element = track["elements"]
                    .as_array()
                    .and_then(|elements| elements.iter().find(|e| e["id"] == input.element_id))
                    .ok_or_else(|| invalid("animation clip not found"))?;
                let catalog = catalog
                    .0
                    .read()
                    .map_err(|_| invalid("animation catalog lock poisoned"))?;
                if catalog.revision.is_empty() {
                    return Err(CapabilityError::Unavailable(
                        "The host has not published its animation parameter catalog".into(),
                    ));
                }
                let query = input.query.unwrap_or_default().to_lowercase();
                let targets: Vec<_> = catalog
                    .targets(element)
                    .into_iter()
                    .filter(|t| {
                        input
                            .property_path
                            .as_ref()
                            .is_none_or(|p| t["propertyPath"] == *p)
                            && (query.is_empty()
                                || serde_json::json!([t["propertyPath"], t["parameter"]["label"]])
                                    .to_string()
                                    .to_lowercase()
                                    .contains(&query))
                    })
                    .collect();
                let total = targets.len();
                let targets = targets
                    .into_iter()
                    .skip(input.offset)
                    .take(limit)
                    .map(|mut t| {
                        if !input.include_parameters {
                            t["label"] = t["parameter"]["label"].clone();
                            t.as_object_mut().unwrap().remove("parameter");
                        }
                        t
                    })
                    .collect();
                Ok(OperationSuccess::new(Output {
                    revision,
                    catalog_revision: catalog.revision.clone(),
                    targets,
                    total,
                    next_offset: input.offset.checked_add(limit).filter(|next| *next < total),
                }))
            }
        },
    )
}
