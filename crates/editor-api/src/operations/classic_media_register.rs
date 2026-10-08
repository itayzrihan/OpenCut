//! Register durable host media metadata; acquiring bytes remains a host effect.
use super::*;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: String,
    expected_revision: u64,
    #[schemars(length(min = 1, max = 1000))]
    assets: Vec<Map<String, Value>>,
}
fn invalid(message: &str) -> CapabilityError {
    CapabilityError::InvalidInput(message.into())
}
fn validate_asset(asset: &Map<String, Value>) -> Result<(), CapabilityError> {
    for (key, bound) in [("id", 160), ("name", 1024)] {
        if !asset
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty() && s.len() <= bound)
        {
            return Err(invalid("Media requires bounded nonempty id and name"));
        }
    }
    if !matches!(
        asset.get("type").and_then(Value::as_str),
        Some("video" | "image" | "audio" | "file")
    ) {
        return Err(invalid("Unsupported media type"));
    }
    if [
        "file",
        "url",
        "buffer",
        "thumbnailUrl",
        "generation",
        "origin",
    ]
    .iter()
    .any(|key| asset.contains_key(*key))
    {
        return Err(invalid(
            "Transient handles and generated/copied ownership bindings are not accepted by metadata registration",
        ));
    }
    for key in ["width", "height", "size", "lastModified", "bindingRevision"] {
        if let Some(value) = asset.get(key).filter(|v| !v.is_null()) {
            let n = value
                .as_u64()
                .filter(|n| *n <= crate::classic::MAX_SAFE_INTEGER as u64)
                .ok_or_else(|| {
                    invalid("Media integer metadata must be nonnegative safe integers")
                })?;
            if matches!(key, "width" | "height") && (n == 0 || n > 65536) {
                return Err(invalid("Media dimensions must be 1..65536"));
            }
        }
    }
    for key in ["duration", "fps"] {
        if let Some(value) = asset.get(key).filter(|v| !v.is_null()) {
            let n = value
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .ok_or_else(|| invalid("Media duration/FPS must be finite and nonnegative"))?;
            if key == "fps" && (n == 0.0 || n > 1000.0) {
                return Err(invalid(
                    "Media FPS must be greater than zero and at most 1000",
                ));
            }
        }
    }
    if serde_json::to_vec(asset)
        .map_err(|_| invalid("Invalid media metadata"))?
        .len()
        > 65536
    {
        return Err(invalid("Media metadata exceeds 64 KiB per asset"));
    }
    Ok(())
}
pub(super) fn register(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    super::register::<Input, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "media.classic.register",
        "Register durable Classic media metadata",
        "Register 1..1000 new media records in the explicit active Classic project after the host has saved their bytes. Metadata only: no upload, file reads, path resolution, decoding, network or permanent deletion. Supply bounded id/name, type (video/image/audio/file), optional dimensions, seconds duration and numeric FPS; transient handles and generation/origin ownership bindings are rejected. Duplicate IDs fail atomically. Unknown serializable extension metadata is preserved. Imported video FPS raises project FPS using the established rational clock; canvas size changes only on timeline insertion. Supports project/revision, dry run, idempotency, cancellation, atomic batches and Undo/Redo. Source bytes remain in host storage during Undo. This does not prove bytes exist: use host import/owned copy/image generation for available sources and inspect missing status separately.",
        "media",
        AccessLevel::Write,
        false,
        false,
        &["classic", "media", "import", "register", "מדיה"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                if input.assets.is_empty() || input.assets.len() > 1000 {
                    return Err(invalid("Expected 1..1000 media records"));
                }
                for asset in &input.assets {
                    validate_asset(asset)?;
                }
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Register project media",
                    Some(input.expected_revision),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(invalid("Target project is not active"));
                        }
                        let classic = project
                            .classic
                            .as_mut()
                            .ok_or_else(|| invalid("Requires Classic media"))?;
                        let mut ids: HashSet<String> = classic
                            .media_assets
                            .iter()
                            .filter_map(|a| a.get("id").and_then(Value::as_str).map(str::to_owned))
                            .collect();
                        let mut changed = Vec::new();
                        let settings = classic.document["settings"]
                            .as_object_mut()
                            .ok_or_else(|| invalid("Classic settings missing"))?;
                        let current = settings["fps"]["numerator"].as_f64().unwrap_or(0.0)
                            / settings["fps"]["denominator"].as_f64().unwrap_or(1.0);
                        let mut highest = current;
                        for asset in &input.assets {
                            let id = asset["id"].as_str().unwrap();
                            if !ids.insert(id.into()) {
                                return Err(invalid(
                                    "Media ID is already registered or duplicated in the batch",
                                ));
                            }
                            changed.push(id.into());
                            if asset["type"] == "video" {
                                highest = highest
                                    .max(asset.get("fps").and_then(Value::as_f64).unwrap_or(0.0));
                            }
                        }
                        if highest > current {
                            settings
                                .insert("fps".into(), super::classic_insert::float_rate(highest));
                        }
                        classic.media_assets.extend(input.assets.clone());
                        project.settings = classic.settings().map_err(|e| invalid(&e.to_string()))?;
                        Ok(changed)
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Registered durable media metadata")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE]))
            }
        },
    )
}
