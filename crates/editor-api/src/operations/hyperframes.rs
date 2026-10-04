use super::*;
use crate::{
    HyperframesComposition, HyperframesInspection, HyperframesPackageFile, HyperframesPackagePlan,
    HyperframesSource, inspect_hyperframes, plan_hyperframes_package,
};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackagePlanInput {
    files: Vec<HyperframesPackageFile>,
    entry_file: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectInput {
    source: HyperframesSource,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareVariablesInput {
    source: HyperframesSource,
    values: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareSourceInput {
    source: HyperframesSource,
    changes: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PrepareSourceOutput {
    source: HyperframesSource,
    source_fingerprint: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetSourceInput {
    project_id: String,
    scene_id: String,
    element_id: String,
    source_fingerprint: String,
    changes: BTreeMap<String, Option<String>>,
    manifest: crate::HyperframesRuntimeManifest,
    expected_revision: u64,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadVariablesOutput {
    declarations: Vec<crate::HyperframesVariable>,
    values: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetVariablesInput {
    project_id: String,
    scene_id: String,
    element_id: String,
    values: BTreeMap<String, Value>,
    manifest: crate::HyperframesRuntimeManifest,
    expected_revision: u64,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValidateManifestInput {
    source: HyperframesSource,
    manifest: crate::HyperframesRuntimeManifest,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadLayerSourceInput {
    source: HyperframesSource,
    manifest: crate::HyperframesRuntimeManifest,
    layer_key: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareAudioInput {
    source: HyperframesSource,
    plan: crate::HyperframesAudioPlan,
    manifest: Option<crate::HyperframesRuntimeManifest>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareLayerEditsInput {
    source: HyperframesSource,
    manifest: crate::HyperframesRuntimeManifest,
    edits: crate::HyperframesLayerEdits,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PrepareLayerEditsOutput {
    layers: Vec<crate::HyperframesLayerRenderEdit>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetLayerOpacityInput {
    project_id: String,
    scene_id: String,
    element_id: String,
    layer_key: String,
    opacity: f64,
    expected_revision: u64,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadAudioInput {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadAudioOutput {
    revision: u64,
    clips: Vec<crate::ClassicHyperframesAudioClip>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadLayerRowsInput {
    project_id: String,
    scene_id: String,
    element_id: String,
    expected_revision: u64,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadLayerRowsOutput {
    revision: u64,
    clip: crate::ClassicHyperframesLayerRows,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetManifestInput {
    project_id: String,
    expected_revision: u64,
    asset_id: String,
    manifest: crate::HyperframesRuntimeManifest,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportInput {
    project_id: String,
    expected_revision: u64,
    name: String,
    /// Durable Classic import-attempt identity for interrupted folder recovery.
    import_id: Option<String>,
    source: HyperframesSource,
    /// Omit to append at the end of the existing timeline.
    start_seconds: Option<f64>,
    /// Omit to create an overlay track in that same timeline.
    track_id: Option<String>,
    /// Runtime-measured duration when the root has no authored data-duration.
    resolved_duration_seconds: Option<f64>,
    /// Observations from the isolated runtime, bound to this exact source.
    runtime_manifest: Option<crate::HyperframesRuntimeManifest>,
    /// Newly persisted Classic resource metadata. Bytes stay in project storage.
    /// Attach these bindings and the composition in one undoable transaction.
    #[serde(default)]
    classic_resource_assets: Vec<Map<String, Value>>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ImportOutput {
    mutation: MutationOutput,
    asset_id: String,
    item_id: String,
    track_id: String,
    inspection: HyperframesInspection,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadLibraryInput {
    project_id: String,
    expected_revision: u64,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadLibraryOutput {
    revision: u64,
    items: Vec<crate::ClassicHyperframesLibraryItem>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InsertInput {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    asset_id: String,
    name: String,
    start_seconds: Option<f64>,
    track_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct InsertOutput {
    mutation: MutationOutput,
    asset_id: String,
    item_id: String,
    track_id: String,
}

pub(super) fn register_hyperframes_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<ReadLayerSourceInput, crate::HyperframesLayerSource, _, _>(
        registry,
        "hyperframes.layer.source.read",
        "Locate the authored source of a HyperFrames layer",
        "Finds an unambiguous HTML opening tag for a runtime layer in the supplied, fingerprint-matched package. Reports source and textarea offsets and known shared occurrences. This is source navigation, not authorization to retime or mutate a runtime occurrence. Does not execute scripts, access files or change editor state.",
        "hyperframes",
        AccessLevel::Read,
        true,
        false,
        &["hyperframes", "source", "layers"],
        |context, input| async move {
            check_cancelled(&context)?;
            let output = crate::read_hyperframes_layer_source(
                &input.source,
                &input.manifest,
                &input.layer_key,
            )
            .map_err(model_error)?;
            check_cancelled(&context)?;
            Ok(OperationSuccess::new(output))
        },
    )?;
    let library_state = state.clone();
    register::<ReadLibraryInput, ReadLibraryOutput, _, _>(
        registry,
        "hyperframes.library.read",
        "Read imported HyperFrames compositions",
        "Lists canonical Classic compositions, their resource bindings and timeline occurrences. Returns display metadata without source text or binary files. Requires the project and exact revision; does not execute source or mutate the document.",
        "hyperframes",
        AccessLevel::Read,
        true,
        false,
        &["hyperframes", "library", "classic"],
        move |context, input| {
            let state = library_state.clone();
            async move {
                check_cancelled(&context)?;
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let document = store.document_for(Some(&input.project_id)).ok_or_else(|| {
                    CapabilityError::Unavailable("HyperFrames library project is not open".into())
                })?;
                check_target(document, &context)?;
                check_revision(document, Some(input.expected_revision))?;
                let classic = document
                    .project
                    .as_ref()
                    .filter(|project| project.id == input.project_id)
                    .and_then(|project| project.classic.as_ref())
                    .ok_or_else(|| {
                        CapabilityError::Unavailable(
                            "HyperFrames library requires a Classic project".into(),
                        )
                    })?;
                let items = classic.hyperframes_library().map_err(model_error)?;
                check_cancelled(&context)?;
                Ok(OperationSuccess::new(ReadLibraryOutput {
                    revision: document.revision,
                    items,
                }))
            }
        },
    )?;
    let insert_state = state.clone();
    let insert_events = events.clone();
    register::<InsertInput, InsertOutput, _, _>(
        registry,
        "timeline.hyperframes.insert",
        "Add an imported HyperFrames composition to the timeline",
        "Adds a new Classic compound occurrence of an existing source package without copying source or media. Requires the active project, scene and revision. Supports placement, undo, dry run and registry idempotency keys; does not execute source or read files.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["hyperframes", "library", "classic", "timeline"],
        move |context, input| {
            let state = insert_state.clone();
            let events = insert_events.clone();
            async move {
                check_cancelled(&context)?;
                let mut item_id = String::new();
                let mut track_id = String::new();
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Add HyperFrames composition",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "HyperFrames target project is not active".into(),
                            ));
                        }
                        let classic = project.classic.as_ref().ok_or_else(|| {
                            CapabilityError::InvalidInput(
                                "Adding an imported composition requires a Classic project".into(),
                            )
                        })?;
                        if classic.document["currentSceneId"] != input.scene_id {
                            return Err(CapabilityError::Conflict(
                                "HyperFrames target scene is not active".into(),
                            ));
                        }
                        let composition = classic
                            .compositions()
                            .map_err(model_error)?
                            .remove(&input.asset_id)
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput(
                                    "HyperFrames composition is missing".into(),
                                )
                            })?;
                        (_, item_id, track_id) = import_classic(
                            document,
                            input.name,
                            input.start_seconds,
                            input.track_id,
                            composition,
                            Some(input.asset_id.clone()),
                        )?;
                        check_cancelled(&context)?;
                        Ok(vec![
                            input.asset_id.clone(),
                            item_id.clone(),
                            track_id.clone(),
                        ])
                    },
                )?;
                Ok(OperationSuccess::new(InsertOutput {
                    mutation,
                    asset_id: input.asset_id,
                    item_id,
                    track_id,
                }))
            }
        },
    )?;
    register::<InspectInput, ReadVariablesOutput, _, _>(
        registry,
        "hyperframes.variables.read",
        "Read HyperFrames variable controls",
        "Reads authored variable declarations from package HTML without executing scripts. Values are global render overrides within a composition occurrence.",
        "hyperframes",
        AccessLevel::Read,
        true,
        false,
        &["hyperframes", "variables"],
        |context, input| async move {
            check_cancelled(&context)?;
            input.source.validate().map_err(model_error)?;
            let declarations = crate::hyperframes_variables(&input.source).map_err(model_error)?;
            check_cancelled(&context)?;
            Ok(OperationSuccess::new(ReadVariablesOutput {
                declarations,
                values: input.source.variables,
            }))
        },
    )?;
    register::<PrepareVariablesInput, HyperframesSource, _, _>(
        registry,
        "hyperframes.variables.prepare",
        "Prepare HyperFrames variable values",
        "Validates declared variable types, bounds and enum choices and returns a derived source for runtime preflight. Original file bytes and resources remain unchanged. Does not execute scripts or access the network.",
        "hyperframes",
        AccessLevel::Read,
        true,
        false,
        &["hyperframes", "variables", "render"],
        |context, input| async move {
            check_cancelled(&context)?;
            input.source.validate().map_err(model_error)?;
            let source = input
                .source
                .with_variables(input.values)
                .map_err(model_error)?;
            check_cancelled(&context)?;
            Ok(OperationSuccess::new(source))
        },
    )?;
    let variables_state = state.clone();
    let variables_events = events.clone();
    register::<SetVariablesInput, MutationOutput, _, _>(
        registry,
        "hyperframes.variables.set",
        "Change HyperFrames composition variables",
        "Commits preflighted render variables to one Classic timeline occurrence, preserving other occurrences and file bytes. Requires the new runtime manifest, explicit project and revision. Preserves clip placement and rejects a shorter source that no longer covers the clip. Supports undo, dry run, cancellation and idempotency.",
        "hyperframes",
        AccessLevel::Write,
        false,
        false,
        &["hyperframes", "variables", "classic", "timeline"],
        move |context, input| {
            let state = variables_state.clone();
            let events = variables_events.clone();
            async move {
                check_cancelled(&context)?;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Change HyperFrames variables",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "HyperFrames target project is not active".into(),
                            ));
                        }
                        let classic = project.classic.as_mut().ok_or_else(|| {
                            CapabilityError::InvalidInput(
                                "Variable edits currently require a Classic project".into(),
                            )
                        })?;
                        classic
                            .set_hyperframes_variables(
                                &input.scene_id,
                                &input.element_id,
                                input.values,
                                input.manifest,
                            )
                            .map_err(model_error)?;
                        check_cancelled(&context)?;
                        Ok(vec![input.element_id])
                    },
                )?;
                Ok(OperationSuccess::new(output))
            }
        },
    )?;
    register::<PrepareSourceInput, PrepareSourceOutput, _, _>(
        registry,
        "hyperframes.source.prepare",
        "Prepare HyperFrames source edits",
        "Applies bounded text file changes to a supplied source package without executing scripts or reading files. A string adds or replaces a file; null removes it. Preserves entry and resource bindings, validates the resulting package, and returns its original fingerprint for a later commit.",
        "hyperframes",
        AccessLevel::Read,
        true,
        false,
        &["hyperframes", "source", "render"],
        |context, input| async move {
            check_cancelled(&context)?;
            let source_fingerprint = input.source.fingerprint();
            let source = input
                .source
                .with_file_changes(input.changes)
                .map_err(model_error)?;
            check_cancelled(&context)?;
            Ok(OperationSuccess::new(PrepareSourceOutput {
                source,
                source_fingerprint,
            }))
        },
    )?;
    let source_state = state.clone();
    let source_events = events.clone();
    register::<SetSourceInput, MutationOutput, _, _>(
        registry,
        "hyperframes.source.set",
        "Edit a HyperFrames composition's source",
        "Commits preflighted source file changes to one Classic timeline occurrence. Requires its original source fingerprint, new runtime manifest, explicit project and exact revision. Shared occurrences detach, locked clips and incompatible layer overrides are rejected, and placement and used duration are preserved. Does not execute scripts or access files or the network. Supports undo, dry run, cancellation and idempotency.",
        "hyperframes",
        AccessLevel::Write,
        false,
        false,
        &["hyperframes", "source", "classic", "timeline"],
        move |context, input| {
            let state = source_state.clone();
            let events = source_events.clone();
            async move {
                check_cancelled(&context)?;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Edit HyperFrames source",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "HyperFrames target project is not active".into(),
                            ));
                        }
                        let classic = project.classic.as_mut().ok_or_else(|| {
                            CapabilityError::InvalidInput(
                                "Source edits currently require a Classic project".into(),
                            )
                        })?;
                        classic
                            .set_hyperframes_source(
                                &input.scene_id,
                                &input.element_id,
                                &input.source_fingerprint,
                                input.changes,
                                input.manifest,
                            )
                            .map_err(model_error)?;
                        check_cancelled(&context)?;
                        Ok(vec![input.element_id])
                    },
                )?;
                Ok(OperationSuccess::new(output))
            }
        },
    )?;
    register::<PrepareLayerEditsInput, PrepareLayerEditsOutput, _, _>(
        registry,
        "hyperframes.layers.render.prepare",
        "Prepare HyperFrames visual layer edits",
        "Validates bounded per-occurrence opacity overrides against the exact source and observed runtime manifest. Returns uniquely addressed visual layers. Does not read files or execute scripts.",
        "hyperframes",
        AccessLevel::Read,
        true,
        false,
        &["hyperframes", "layers", "render"],
        |context, input| async move {
            check_cancelled(&context)?;
            let plan = input
                .edits
                .prepare(&input.source, &input.manifest)
                .map_err(model_error)?;
            check_cancelled(&context)?;
            Ok(OperationSuccess::new(PrepareLayerEditsOutput {
                layers: plan,
            }))
        },
    )?;
    let edit_state = state.clone();
    let edit_events = events.clone();
    register::<SetLayerOpacityInput, MutationOutput, _, _>(
        registry,
        "hyperframes.layer.opacity.set",
        "Change a HyperFrames layer's opacity",
        "Sets visual opacity within one Classic compound clip, preserving source animation and other occurrences. One resets the override; zero hides the layer. Embedded audio is unchanged. Requires an explicit project, scene, element, layer and revision; rejects locked tracks. Supports undo, dry run, cancellation and registry idempotency keys.",
        "hyperframes",
        AccessLevel::Write,
        false,
        false,
        &["hyperframes", "layers", "classic", "timeline", "opacity"],
        move |context, input| {
            let state = edit_state.clone();
            let events = edit_events.clone();
            async move {
                check_cancelled(&context)?;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Change HyperFrames layer opacity",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "HyperFrames target project is not active".into(),
                            ));
                        }
                        let classic = project.classic.as_mut().ok_or_else(|| {
                            CapabilityError::InvalidInput(
                                "Layer edits currently require a Classic project".into(),
                            )
                        })?;
                        classic
                            .set_hyperframes_layer_opacity(
                                &input.scene_id,
                                &input.element_id,
                                &input.layer_key,
                                input.opacity,
                            )
                            .map_err(model_error)?;
                        check_cancelled(&context)?;
                        Ok(vec![input.element_id])
                    },
                )?;
                Ok(OperationSuccess::new(output))
            }
        },
    )?;
    let layers_state = state.clone();
    register::<ReadLayerRowsInput, ReadLayerRowsOutput, _, _>(
        registry,
        "hyperframes.layers.timeline.read",
        "Read composition layers on the Classic timeline",
        "Projects validated runtime layers into the existing compound clip's timeline window. Preserves occurrence identity and hierarchy, applies trim and ancestor windows, and follows canonical edits and undo. Requires a project, scene, compound element and exact revision. Does not execute source or add tracks.",
        "hyperframes",
        AccessLevel::Read,
        true,
        false,
        &["hyperframes", "layers", "classic", "timeline"],
        move |context, input| {
            let state = layers_state.clone();
            async move {
                check_cancelled(&context)?;
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let document = store.document_for(Some(&input.project_id)).ok_or_else(|| {
                    CapabilityError::Unavailable("HyperFrames layer project is not open".into())
                })?;
                check_target(document, &context)?;
                check_revision(document, Some(input.expected_revision))?;
                let classic = document
                    .project
                    .as_ref()
                    .filter(|project| project.id == input.project_id)
                    .and_then(|project| project.classic.as_ref())
                    .ok_or_else(|| {
                        CapabilityError::Unavailable(
                            "HyperFrames layer rows require a Classic project".into(),
                        )
                    })?;
                let clip = classic
                    .hyperframes_layer_rows(&input.scene_id, &input.element_id)
                    .map_err(model_error)?;
                check_cancelled(&context)?;
                Ok(OperationSuccess::new(ReadLayerRowsOutput {
                    revision: document.revision,
                    clip,
                }))
            }
        },
    )?;
    let audio_state = state.clone();
    register::<ReadAudioInput, ReadAudioOutput, _, _>(
        registry,
        "hyperframes.audio.clips.read",
        "Read HyperFrames timeline audio clips",
        "Projects compound clips in a canonical Classic scene into derived audio mixer inputs. Preserves placement, trim and gain, bounds audio to the authored source duration, and follows undo history. Requires a project, scene and exact revision. Does not read files, render audio or add tracks.",
        "hyperframes",
        AccessLevel::Read,
        true,
        false,
        &["hyperframes", "audio", "classic", "timeline"],
        move |context, input| {
            let state = audio_state.clone();
            async move {
                check_cancelled(&context)?;
                let store = state.read().map_err(|_| {
                    CapabilityError::Failed("editor state lock was poisoned".into())
                })?;
                let document = store.document_for(Some(&input.project_id)).ok_or_else(|| {
                    CapabilityError::Unavailable("HyperFrames audio project is not open".into())
                })?;
                check_target(document, &context)?;
                check_revision(document, Some(input.expected_revision))?;
                let classic = document
                    .project
                    .as_ref()
                    .filter(|project| project.id == input.project_id)
                    .and_then(|project| project.classic.as_ref())
                    .ok_or_else(|| {
                        CapabilityError::Unavailable(
                            "HyperFrames audio requires a Classic project".into(),
                        )
                    })?;
                let clips = classic
                    .hyperframes_audio_clips(&input.scene_id)
                    .map_err(model_error)?;
                check_cancelled(&context)?;
                Ok(OperationSuccess::new(ReadAudioOutput {
                    revision: document.revision,
                    clips,
                }))
            }
        },
    )?;
    register::<PackagePlanInput, HyperframesPackagePlan, _, _>(
        registry,
        "hyperframes.package.plan",
        "Plan HyperFrames folder import",
        "Validates supplied relative paths and byte sizes, identifies HTML entry candidates and separates UTF-8 source from durable binary resources. Excludes node_modules and .git. Does not read or execute files.",
        "hyperframes",
        AccessLevel::Read,
        true,
        false,
        &["hyperframes", "package", "import"],
        |context, input| async move {
            check_cancelled(&context)?;
            let plan =
                plan_hyperframes_package(input.files, input.entry_file).map_err(model_error)?;
            check_cancelled(&context)?;
            Ok(OperationSuccess::new(plan))
        },
    )?;
    register::<InspectInput, HyperframesInspection, _, _>(
        registry,
        "hyperframes.project.inspect",
        "Inspect HyperFrames project",
        "Inspects supplied HyperFrames source without executing scripts or fetching files. Retains authored layers, nested hosts, resource references and unresolved runtime requirements.",
        "hyperframes",
        AccessLevel::Read,
        true,
        false,
        &["hyperframes", "html", "composition", "layers", "import"],
        |context, input| async move {
            check_cancelled(&context)?;
            let inspection = inspect_hyperframes(&input.source).map_err(model_error)?;
            check_cancelled(&context)?;
            Ok(OperationSuccess::new(inspection))
        },
    )?;
    register::<ValidateManifestInput, crate::HyperframesRuntimeManifest, _, _>(
        registry,
        "hyperframes.manifest.validate",
        "Validate HyperFrames runtime manifest",
        "Validates bounded runtime layer and media observations against their exact source fingerprint. Checks package references, occurrence identity, parent hierarchy and timing without executing scripts or reading files.",
        "hyperframes",
        AccessLevel::Read,
        true,
        false,
        &["hyperframes", "runtime", "layers", "media"],
        |context, input| async move {
            check_cancelled(&context)?;
            input
                .manifest
                .validate(&input.source)
                .map_err(model_error)?;
            check_cancelled(&context)?;
            Ok(OperationSuccess::new(input.manifest))
        },
    )?;
    let manifest_state = state.clone();
    register::<PrepareAudioInput, crate::HyperframesAudioPlan, _, _>(
        registry,
        "hyperframes.audio.prepare",
        "Validate HyperFrames audio render plan",
        "Validates a bounded, derived audio plan against its source fingerprint and registered resources. Normalizes temporary track and group IDs. Does not read files, execute scripts or render audio.",
        "hyperframes",
        AccessLevel::Read,
        true,
        false,
        &["hyperframes", "audio", "render"],
        |context, input| async move {
            check_cancelled(&context)?;
            if let Some(manifest) = &input.manifest {
                manifest.validate(&input.source).map_err(model_error)?;
                if manifest.duration_seconds != input.plan.duration_seconds
                    || manifest.runtime_version != input.plan.runtime_version
                {
                    return Err(CapabilityError::InvalidInput(
                        "audio plan and runtime manifest disagree".into(),
                    ));
                }
                crate::validate_hyperframes_audio_windows(manifest).map_err(model_error)?;
            }
            let plan = input.plan.prepare(&input.source).map_err(model_error)?;
            check_cancelled(&context)?;
            Ok(OperationSuccess::new(plan))
        },
    )?;
    let manifest_events = events.clone();
    register::<SetManifestInput, MutationOutput, _, _>(
        registry,
        "hyperframes.manifest.set",
        "Update HyperFrames runtime layers",
        "Stores validated runtime layer and media observations on an existing composition. Requires the exact source fingerprint, project and revision. Supports undo, dry run, cancellation and registry idempotency keys.",
        "hyperframes",
        AccessLevel::Write,
        false,
        false,
        &["hyperframes", "runtime", "layers", "media"],
        move |context, input| {
            let state = manifest_state.clone();
            let events = manifest_events.clone();
            async move {
                check_cancelled(&context)?;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Update HyperFrames layers",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "HyperFrames target project is not active".into(),
                            ));
                        }
                        if let Some(classic) = &mut project.classic {
                            let composition = classic
                                .document
                                .compositions
                                .as_mut()
                                .and_then(|items| items.get_mut(&input.asset_id))
                                .ok_or_else(|| {
                                    CapabilityError::InvalidInput(
                                        "HyperFrames composition is missing".into(),
                                    )
                                })?;
                            input
                                .manifest
                                .validate(&composition.source)
                                .map_err(model_error)?;
                            composition.properties.insert(
                                "runtimeManifest".into(),
                                serde_json::to_value(&input.manifest)
                                    .map_err(|error| CapabilityError::Failed(error.to_string()))?,
                            );
                        } else {
                            let composition = project
                                .assets
                                .iter_mut()
                                .find(|asset| asset.id == input.asset_id)
                                .and_then(|asset| asset.hyperframes.as_mut())
                                .ok_or_else(|| {
                                    CapabilityError::InvalidInput(
                                        "HyperFrames composition is missing".into(),
                                    )
                                })?;
                            input
                                .manifest
                                .validate(&composition.source)
                                .map_err(model_error)?;
                            composition.runtime_manifest = Some(input.manifest);
                        }
                        check_cancelled(&context)?;
                        Ok(vec![input.asset_id])
                    },
                )?;
                Ok(OperationSuccess::new(output))
            }
        },
    )?;
    register::<ImportInput, ImportOutput, _, _>(
        registry,
        "timeline.hyperframes.import",
        "Import HyperFrames into timeline",
        "Preserves a HyperFrames source package as a compound clip in the existing timeline. Appends by default or places at an explicit time on an existing visual track. Supports revision checks, undo, dry run and registry idempotency keys. Playback requires the HyperFrames renderer integration.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &[
            "hyperframes",
            "html",
            "composition",
            "compound",
            "import",
            "timeline",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                check_cancelled(&context)?;
                let inspection = inspect_hyperframes(&input.source).map_err(model_error)?;
                let duration = inspection.duration_seconds.or(input.resolved_duration_seconds)
                    .ok_or_else(|| CapabilityError::InvalidInput(
                        "HyperFrames duration is unresolved; supply a runtime-measured resolvedDurationSeconds".into()
                    ))?;
                let composition = HyperframesComposition {
                    source: Arc::new(input.source),
                    composition_id: inspection.composition_id.clone(),
                    width: inspection.width,
                    height: inspection.height,
                    fps: inspection.fps,
                    duration_seconds: duration,
                    runtime_manifest: input.runtime_manifest,
                };
                composition.validate().map_err(model_error)?;
                let mut asset_id = String::new();
                let mut item_id = String::new();
                let mut track_id = String::new();
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Import HyperFrames project",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "HyperFrames target project is not active".into(),
                            ));
                        }
                        if let Some(classic) = &mut project.classic {
                            let resource_ids = attach_classic_resources(
                                classic,
                                &composition.source,
                                input.classic_resource_assets,
                            )?;
                            (asset_id, item_id, track_id) = import_classic(
                                document,
                                input.name,
                                input.start_seconds,
                                input.track_id,
                                composition,
                                None,
                            )?;
                            if let Some(import_id) = input.import_id {
                                project_mut(document)?
                                    .classic
                                    .as_mut()
                                    .unwrap()
                                    .document
                                    .compositions
                                    .as_mut()
                                    .unwrap()
                                    .get_mut(&asset_id)
                                    .unwrap()
                                    .properties
                                    .insert("importId".into(), Value::String(import_id));
                            }
                            check_cancelled(&context)?;
                            let mut affected =
                                vec![asset_id.clone(), item_id.clone(), track_id.clone()];
                            affected.extend(resource_ids);
                            return Ok(affected);
                        }
                        if !input.classic_resource_assets.is_empty() {
                            return Err(CapabilityError::InvalidInput(
                                "classicResourceAssets requires a Classic project".into(),
                            ));
                        }
                        if input.import_id.is_some() {
                            return Err(CapabilityError::InvalidInput(
                                "importId requires a Classic project".into(),
                            ));
                        }
                        let start = input
                            .start_seconds
                            .unwrap_or_else(|| project.timeline.duration());
                        if let Some(id) = &input.track_id {
                            let track = project
                                .timeline
                                .tracks
                                .iter()
                                .find(|track| &track.id == id)
                                .ok_or_else(|| {
                                    CapabilityError::InvalidInput(
                                        "HyperFrames target track does not exist".into(),
                                    )
                                })?;
                            ensure_unlocked(track, None)?;
                            if !matches!(track.kind, TrackKind::Video | TrackKind::Overlay) {
                                return Err(CapabilityError::InvalidInput(
                                    "HyperFrames requires a video or overlay track".into(),
                                ));
                            }
                        }
                        asset_id = document.allocate_id("asset");
                        item_id = document.allocate_id("item");
                        track_id = input
                            .track_id
                            .clone()
                            .unwrap_or_else(|| document.allocate_id("track"));
                        let project = project_mut(document)?;
                        if input.track_id.is_none() {
                            project.timeline.tracks.push(new_track(
                                track_id.clone(),
                                "HyperFrames",
                                TrackKind::Overlay,
                            ));
                        }
                        project.assets.push(MediaAsset {
                            id: asset_id.clone(),
                            name: input.name.clone(),
                            source: format!("opencut://hyperframes/{}", inspection.fingerprint),
                            media_type: MediaType::Other,
                            duration_seconds: Some(duration),
                            width: Some(inspection.width),
                            height: Some(inspection.height),
                            frame_rate: Some(inspection.fps),
                            sample_rate: None,
                            channels: None,
                            has_video: true,
                            has_audio: true,
                            proxy_source: None,
                            offline: false,
                            unified_angles: None,
                            hyperframes: Some(composition),
                            metadata: Default::default(),
                            extensions: Map::new(),
                        });
                        let track = project
                            .timeline
                            .tracks
                            .iter_mut()
                            .find(|track| track.id == track_id)
                            .unwrap();
                        track.items.push(TimelineItem {
                            id: item_id.clone(),
                            name: input.name,
                            kind: TimelineItemKind::Compound,
                            start_seconds: start,
                            duration_seconds: duration,
                            start: None,
                            duration: None,
                            source_in_seconds: 0.0,
                            source_out_seconds: Some(duration),
                            source_in: None,
                            source_out: None,
                            speed: 1.0,
                            enabled: true,
                            locked: false,
                            group_id: None,
                            linked_item_ids: Default::default(),
                            asset_id: Some(asset_id.clone()),
                            active_angle_asset_id: None,
                            fit_mode: None,
                            transform: Transform::default(),
                            opacity: 1.0,
                            blend_mode: BlendMode::default(),
                            audio: AudioProperties::default(),
                            text: None,
                            shape: None,
                            smart_layer: None,
                            masks: Vec::new(),
                            effects: Vec::new(),
                            keyframes: Vec::new(),
                            metadata: Default::default(),
                            extensions: Map::new(),
                        });
                        check_cancelled(&context)?;
                        Ok(vec![asset_id.clone(), item_id.clone(), track_id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(ImportOutput {
                    mutation,
                    asset_id,
                    item_id,
                    track_id,
                    inspection,
                })
                .summary("Imported HyperFrames source into the existing timeline")
                .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}

fn model_error(error: ModelError) -> CapabilityError {
    CapabilityError::InvalidInput(error.to_string())
}
fn check_cancelled(context: &InvocationContext) -> Result<(), CapabilityError> {
    if context.cancellation.is_cancelled() {
        Err(CapabilityError::Failed(
            "HyperFrames operation was cancelled".into(),
        ))
    } else {
        Ok(())
    }
}

fn attach_classic_resources(
    classic: &mut crate::ClassicProject,
    source: &HyperframesSource,
    resources: Vec<Map<String, Value>>,
) -> Result<Vec<String>, CapabilityError> {
    let allowed: HashSet<&str> = source
        .resource_asset_ids
        .values()
        .map(String::as_str)
        .collect();
    if resources.len() > allowed.len() {
        return Err(CapabilityError::InvalidInput(
            "Too many HyperFrames resource bindings".into(),
        ));
    }
    let mut occupied: HashSet<String> = classic
        .media_assets
        .iter()
        .filter_map(|asset| asset.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let mut ids = Vec::with_capacity(resources.len());
    for resource in &resources {
        if !matches!(
            resource.get("type").and_then(Value::as_str),
            Some("file" | "image" | "audio" | "video")
        ) {
            return Err(CapabilityError::InvalidInput(
                "Unsupported HyperFrames resource media type".into(),
            ));
        }
        let id = resource
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| allowed.contains(id))
            .ok_or_else(|| {
                CapabilityError::InvalidInput(
                    "New media must be bound by the imported HyperFrames source".into(),
                )
            })?;
        if !occupied.insert(id.to_owned()) {
            return Err(CapabilityError::InvalidInput(
                "HyperFrames resource binding would replace an existing media ID".into(),
            ));
        }
        ids.push(id.to_owned());
    }
    classic.media_assets.extend(resources);
    // The enclosing canonical mutation validates the complete Classic project,
    // including transient handles and source references.
    Ok(ids)
}

fn import_classic(
    document: &mut EditorDocument,
    name: String,
    start_seconds: Option<f64>,
    target_track_id: Option<String>,
    composition: HyperframesComposition,
    existing_asset_id: Option<String>,
) -> Result<(String, String, String), CapabilityError> {
    use crate::CLASSIC_TICKS_PER_SECOND;
    use serde_json::json;
    let classic = document.project.as_ref().unwrap().classic.as_ref().unwrap();
    let start = start_seconds.unwrap_or_else(|| classic.duration());
    let to_ticks = |seconds: f64| {
        let ticks = (seconds * CLASSIC_TICKS_PER_SECOND as f64).round();
        if seconds < 0.0 || !ticks.is_finite() || !(0.0..=9_007_199_254_740_991.0).contains(&ticks)
        {
            return Err(CapabilityError::InvalidInput(
                "HyperFrames timing exceeds Classic's safe integer clock".into(),
            ));
        }
        Ok(ticks as i64)
    };
    let start_ticks = to_ticks(start)?;
    let duration_ticks = to_ticks(composition.duration_seconds)?;
    if duration_ticks == 0 {
        return Err(CapabilityError::InvalidInput(
            "HyperFrames duration is shorter than one Classic tick".into(),
        ));
    }
    let mut occupied = HashSet::new();
    for scene in classic.scenes().map_err(model_error)? {
        occupied.insert(scene["id"].as_str().unwrap_or_default().to_owned());
        for track in crate::classic::tracks(scene).map_err(model_error)? {
            occupied.insert(track["id"].as_str().unwrap_or_default().to_owned());
            for element in track["elements"].as_array().unwrap() {
                occupied.insert(element["id"].as_str().unwrap_or_default().to_owned());
            }
        }
    }
    occupied.extend(classic.compositions().map_err(model_error)?.into_keys());
    occupied.extend(
        classic
            .media_assets
            .iter()
            .filter_map(|asset| asset.get("id").and_then(Value::as_str).map(str::to_owned)),
    );
    let mut allocate = |prefix| loop {
        let id = document.allocate_id(prefix);
        if occupied.insert(id.clone()) {
            break id;
        }
    };
    let asset_id = existing_asset_id
        .clone()
        .unwrap_or_else(|| allocate("hyperframes"));
    let item_id = allocate("item");
    let track_id = target_track_id.clone().unwrap_or_else(|| allocate("track"));
    let classic = document.project.as_mut().unwrap().classic.as_mut().unwrap();
    let active = classic.document["currentSceneId"].clone();
    let scene = classic
        .document
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .unwrap()
        .iter_mut()
        .find(|scene| scene["id"] == active)
        .unwrap();
    let tracks = scene["tracks"].as_object_mut().unwrap();
    // A composition is a graphic element, so use the existing graphic lanes.
    // Main video and other layer kinds retain their established element types.
    if target_track_id.is_none() {
        tracks.get_mut("overlay").and_then(Value::as_array_mut).unwrap().insert(0, json!({
            "id":track_id, "name":"HyperFrames", "type":"graphic", "hidden":false, "elements":[]
        }));
        if let Some(order) = tracks.get_mut("order").and_then(Value::as_array_mut) {
            order.insert(0, json!(track_id));
        }
    }
    let track = tracks
        .get_mut("overlay")
        .and_then(Value::as_array_mut)
        .unwrap()
        .iter_mut()
        .find(|track| track["id"] == track_id)
        .ok_or_else(|| {
            CapabilityError::InvalidInput(
                "HyperFrames requires an existing Classic graphic overlay track".into(),
            )
        })?;
    if track["type"] != "graphic" || track["locked"] == true {
        return Err(CapabilityError::InvalidInput(
            "HyperFrames target must be an unlocked graphic track".into(),
        ));
    }
    track["elements"].as_array_mut().unwrap().push(json!({
        "id":item_id, "name":name, "type":"graphic", "definitionId":"hyperframes",
        "startTime":start_ticks, "duration":duration_ticks, "trimStart":0, "trimEnd":0,
        "sourceDuration":duration_ticks,
        "params":{"hyperframesAssetId":asset_id,"sourceWidth":composition.width,"sourceHeight":composition.height}, "hidden":false
    }));
    if existing_asset_id.is_none() {
        classic
            .document
            .compositions
            .get_or_insert_default()
            .insert(asset_id.clone(), composition.into());
    }
    let duration = (classic.main_scene_duration() * CLASSIC_TICKS_PER_SECOND as f64).round() as i64;
    classic
        .document
        .get_mut("metadata")
        .and_then(Value::as_object_mut)
        .unwrap()
        .insert("duration".into(), json!(duration));
    Ok((asset_id, item_id, track_id))
}
