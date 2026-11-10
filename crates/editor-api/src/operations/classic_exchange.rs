//! Portable project exchange uses the canonical restore/attach validators.
//! It prepares an independent archive; it never changes the open editor.
use super::*;
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    #[serde(default)]
    expected_revision: Option<u64>,
    archive: Value,
    #[serde(default)]
    destination_project_id: Option<String>,
    #[serde(default)]
    shared_audio_ids: BTreeMap<String, String>,
    #[serde(default)]
    shared_sticker_ids: BTreeMap<String, String>,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Output {
    archive: Value,
    classic: Value,
    project_extensions: Map<String, Value>,
    media_assets: Vec<Value>,
    references: Vec<Value>,
}

async fn call(
    runtime: &crate::OpenCutRuntime,
    id: &str,
    input: Value,
) -> Result<Value, CapabilityError> {
    runtime
        .registry()
        .invoke(id, InvocationContext::default(), input)
        .await
        .map(|reply| reply.result.data)
        .map_err(|error| CapabilityError::InvalidInput(error.to_string()))
}

fn rebind_classic(
    classic: &mut Value,
    destination: &str,
    audio: &BTreeMap<String, String>,
    stickers: &BTreeMap<String, String>,
) {
    classic["document"]["metadata"]["id"] = destination.into();
    if let Some(assets) = classic["mediaAssets"].as_array_mut() {
        for asset in assets {
            if let Some(fields) = asset.as_object_mut() {
                // Import is explicit user-selected media, never a machine path
                // or an authenticated URL embedded in an untrusted document.
                for key in [
                    "sourcePath",
                    "storedPath",
                    "url",
                    "file",
                    "thumbnailUrl",
                    "canUndoRelink",
                ] {
                    fields.remove(key);
                }
                fields.insert("storageKind".into(), "copied".into());
                fields.insert("bindingRevision".into(), 0.into());
                fields.insert(
                    "missing".into(),
                    (!fields.contains_key("unifiedAngles")).into(),
                );
            }
        }
    }
    fn shared(
        value: &mut Value,
        audio: &BTreeMap<String, String>,
        stickers: &BTreeMap<String, String>,
    ) {
        match value {
            Value::Object(fields) => {
                if fields.get("type").and_then(Value::as_str) == Some("audio")
                    && fields.get("sourceType").and_then(Value::as_str) == Some("library")
                    && fields.get("librarySourceType").and_then(Value::as_str) == Some("shared")
                {
                    if let Some(id) = fields
                        .get("libraryAssetId")
                        .and_then(Value::as_str)
                        .and_then(|id| audio.get(id))
                        .cloned()
                    {
                        fields.insert("libraryAssetId".into(), id.into());
                    }
                }
                if fields.get("type").and_then(Value::as_str) == Some("sticker") {
                    if let Some(id) = fields
                        .get("stickerId")
                        .and_then(Value::as_str)
                        .and_then(|id| id.strip_prefix("user-stickers:"))
                        .and_then(|id| stickers.get(id))
                        .cloned()
                    {
                        fields.insert("stickerId".into(), format!("user-stickers:{id}").into());
                    }
                }
                for child in fields.values_mut() {
                    shared(child, audio, stickers);
                }
            }
            Value::Array(items) => {
                for child in items {
                    shared(child, audio, stickers);
                }
            }
            _ => {}
        }
    }
    shared(&mut classic["document"], audio, stickers);
}

fn collect(
    snapshot: &Value,
    media: &mut BTreeMap<String, Value>,
    references: &mut BTreeMap<String, Value>,
) -> Result<(), CapabilityError> {
    if let Some(assets) = snapshot["classic"]["mediaAssets"].as_array() {
        for asset in assets {
            if let Some(id) = asset["id"].as_str() {
                if let Some(prior) = media.get(id) {
                    for pointer in [
                        "/size",
                        "/sourcePath",
                        "/generation/sha256",
                        "/bindingRevision",
                        "/lastModified",
                    ] {
                        if let (Some(a), Some(b)) = (prior.pointer(pointer), asset.pointer(pointer))
                        {
                            if !a.is_null() && !b.is_null() && a != b {
                                return Err(CapabilityError::InvalidInput(format!(
                                    "Media {id} has different original file versions in history; archive them separately before portable export"
                                )));
                            }
                        }
                    }
                }
                media.entry(id.into()).or_insert_with(|| asset.clone());
            }
        }
    }
    if let Some(assets) = snapshot["projectExtensions"]["generative"]["references"].as_array() {
        for asset in assets {
            if let Some(id) = asset["id"].as_str() {
                references.entry(id.into()).or_insert_with(|| asset.clone());
            }
        }
    }
    Ok(())
}

pub(super) fn register_classic_exchange_operations(
    registry: &CapabilityRegistry,
) -> Result<(), RegistryError> {
    register::<Input, Output, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "project.classic.exchange.prepare",
        "Validate a portable POCUT project archive",
        "Validates the complete canonical archive and all undo/redo boundaries in an isolated runtime. Returns a normalized full archive and the union of current/history media and Director references. Optional destinationProjectId forks the complete editing history to a fresh identity and removes source paths/URLs from every media binding; the host must explicitly relink original bytes. Does not mutate the active editor, read files, resume provider jobs, or import account/agent sessions. The host serializes this lossless metadata as POCUT XML or adds owned media bytes for ZIP.",
        "project",
        AccessLevel::Read,
        true,
        false,
        &["classic", "archive", "xml", "import", "export"],
        |_, input| async move {
            if serde_json::to_vec(&input.archive)
                .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?
                .len()
                > 120_000_000
            {
                return Err(CapabilityError::InvalidInput(
                    "Project exchange metadata exceeds 120 MB".into(),
                ));
            }
            if input
                .expected_revision
                .is_some_and(|revision| input.archive["revision"].as_u64() != Some(revision))
            {
                return Err(CapabilityError::Conflict(
                    "Project archive revision changed".into(),
                ));
            }
            let source = crate::OpenCutRuntime::default();
            call(
                &source,
                "project.classic.session.restore",
                json!({"projectId":input.project_id,"expectedRevision":0,"archive":input.archive}),
            )
            .await?;
            let mut session = call(
                &source,
                "project.classic.session.read",
                json!({"projectId":input.project_id}),
            )
            .await?;
            let mut source_media = BTreeMap::new();
            let mut source_refs = BTreeMap::new();
            collect(&session, &mut source_media, &mut source_refs)?;
            for stack in ["undoStack", "redoStack"] {
                for boundary in session[stack].as_array().expect("validated session stack") {
                    collect(boundary, &mut source_media, &mut source_refs)?;
                }
            }
            if input.shared_audio_ids.len() + input.shared_sticker_ids.len() > 20_000
                || input
                    .shared_audio_ids
                    .values()
                    .chain(input.shared_sticker_ids.values())
                    .any(|id| {
                        id.is_empty()
                            || id.len() > 256
                            || !id
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                    })
            {
                return Err(CapabilityError::InvalidInput(
                    "Invalid shared asset mapping".into(),
                ));
            }
            if let Some(destination) = &input.destination_project_id {
                if destination == &input.project_id
                    || destination.is_empty()
                    || destination.len() > 128
                    || !destination
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                {
                    return Err(CapabilityError::InvalidInput(
                        "Import requires a fresh valid project identity".into(),
                    ));
                }
                rebind_classic(
                    &mut session["classic"],
                    destination,
                    &input.shared_audio_ids,
                    &input.shared_sticker_ids,
                );
                for stack in ["undoStack", "redoStack"] {
                    for boundary in session[stack]
                        .as_array_mut()
                        .expect("validated session stack")
                    {
                        rebind_classic(
                            &mut boundary["classic"],
                            destination,
                            &input.shared_audio_ids,
                            &input.shared_sticker_ids,
                        );
                        // Host callbacks/selection handles belong to the original host.
                        boundary["hostContext"] = json!({});
                    }
                }
            }
            let mut media = BTreeMap::new();
            let mut references = BTreeMap::new();
            collect(&session, &mut media, &mut references)?;
            for stack in ["undoStack", "redoStack"] {
                for boundary in session[stack]
                    .as_array()
                    .expect("validated session stack")
                    .iter()
                    .rev()
                {
                    collect(boundary, &mut media, &mut references)?;
                }
            }
            let destination = input
                .destination_project_id
                .as_deref()
                .unwrap_or(&input.project_id);
            let archive = if input.destination_project_id.is_some() {
                let fork = crate::OpenCutRuntime::default();
                call(&fork,"project.classic.session.attach",json!({"projectId":destination,"expectedRevision":0,"classic":session["classic"],"projectExtensions":session["projectExtensions"],"undoStack":session["undoStack"],"redoStack":session["redoStack"]})).await?;
                call(
                    &fork,
                    "project.classic.session.archive",
                    json!({"projectId":destination}),
                )
                .await?
            } else {
                call(
                    &source,
                    "project.classic.session.archive",
                    json!({"projectId":destination}),
                )
                .await?
            };
            Ok(OperationSuccess::new(Output {
                archive,
                classic: session["classic"].clone(),
                project_extensions: session["projectExtensions"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                media_assets: media.into_values().collect(),
                references: references.into_values().collect(),
            }))
        },
    )
}
