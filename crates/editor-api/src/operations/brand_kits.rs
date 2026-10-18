//! Brand kit CRUD and Full Auto finishing share the canonical document/history.
use super::*;
use opencut_account_core::brand_kit::BrandKit;
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditInput {
    account_id: String,
    expected_revision: u64,
    change: Change,
}
#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Change {
    Upsert { kit: BrandKit },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveInput {
    account_id: String,
    expected_revision: u64,
    kit_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyInput {
    project_id: String,
    scene_id: String,
    expected_revision: u64,
    /// Frozen kit from the authenticated account; later library edits never restyle old jobs.
    kit: BrandKit,
    #[serde(default)]
    sfx_duration_ticks: BTreeMap<String, i64>,
}

pub(super) fn register_brand_kits(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let edit_state = state.clone();
    let edit_events = events.clone();
    register::<EditInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "account.brand_kits.edit",
        "Edit account Brand Kits",
        "Create/update one named Brand Kit in the authenticated account. Multiple kits have stable IDs; validate logo library references, hex palette, fonts, style, phrases and sound IDs. The host authenticates and loads the account. Explicit account ID and optimistic revision are mandatory. Atomic, undoable, dry-run and idempotency supported. No file or network IO. Read kits through app.state.read at /account/brandKits.",
        "account",
        AccessLevel::Write,
        false,
        false,
        &["brand-kit", "account", "branding", "palette", "fonts"],
        move |context, input| {
            let state = edit_state.clone();
            let events = edit_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Edit Brand Kit",
                    Some(input.expected_revision),
                    |document| {
                        let account = document.account.as_mut().ok_or_else(|| {
                            CapabilityError::InvalidInput("No authenticated account loaded".into())
                        })?;
                        if account.id != input.account_id {
                            return Err(CapabilityError::Conflict(
                                "Brand Kit account mismatch".into(),
                            ));
                        }
                        let id = match input.change {
                            Change::Upsert { kit } => {
                                kit.validate().map_err(CapabilityError::InvalidInput)?;
                                let id = kit.id.clone();
                                if let Some(old) =
                                    account.brand_kits.iter_mut().find(|k| k.id == id)
                                {
                                    *old = kit;
                                } else {
                                    account.brand_kits.push(kit);
                                }
                                id
                            }
                        };
                        Ok(vec![account.id.clone(), id])
                    },
                )?;
                Ok(OperationSuccess::new(output).changed([STATE_RESOURCE]))
            }
        },
    )?;
    let remove_state = state.clone();
    let remove_events = events.clone();
    register::<RemoveInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "account.brand_kits.remove",
        "Remove account Brand Kit",
        "Delete one saved Brand Kit from the explicit authenticated account. Existing timeline snapshots and queued recipes are preserved. Destructive, revision fenced, atomic and undoable; supports dry run and idempotency. No file IO or asset deletion.",
        "account",
        AccessLevel::Destructive,
        false,
        false,
        &["brand-kit", "account", "delete"],
        move |context, input| {
            let state = remove_state.clone();
            let events = remove_events.clone();
            async move {
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Remove Brand Kit",
                    Some(input.expected_revision),
                    |document| {
                        let account = document.account.as_mut().ok_or_else(|| {
                            CapabilityError::InvalidInput("No authenticated account loaded".into())
                        })?;
                        if account.id != input.account_id {
                            return Err(CapabilityError::Conflict(
                                "Brand Kit account mismatch".into(),
                            ));
                        }
                        let index = account
                            .brand_kits
                            .iter()
                            .position(|kit| kit.id == input.kit_id)
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput("Brand Kit not found".into())
                            })?;
                        account.brand_kits.remove(index);
                        Ok(vec![account.id.clone(), input.kit_id])
                    },
                )?;
                Ok(OperationSuccess::new(output).changed([STATE_RESOURCE]))
            }
        },
    )?;
    register::<ApplyInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "timeline.classic.brand_kit.apply",
        "Apply Brand Kit to Full Auto edit",
        "Apply a validated frozen Brand Kit to one explicit Classic scene: caption/body and heading fonts, primary text and secondary gradient/accent colors, canvas background, editable logo and optional closing phrase. Replace only prior Brand Kit overlays; keep speech, cut timing, unrelated scenes and unknown fields. Bind logo/sound IDs to the host account library before applying. Sound preferences restrict automatic music selection; existing Full Auto generated SFX are replaced with selected brand SFX. No asset IO. Atomic, undoable, revision fenced, dry-run and idempotency supported.",
        "timeline",
        AccessLevel::Write,
        false,
        false,
        &["brand-kit", "classic", "full-auto", "branding"],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                input
                    .kit
                    .validate()
                    .map_err(CapabilityError::InvalidInput)?;
                let output = mutate(
                    &state,
                    &events,
                    &context,
                    "Apply Brand Kit",
                    Some(input.expected_revision),
                    |document| apply(document, input),
                )?;
                Ok(OperationSuccess::new(output).changed([
                    STATE_RESOURCE,
                    PROJECT_RESOURCE,
                    TIMELINE_RESOURCE,
                ]))
            }
        },
    )
}
fn apply(document: &mut EditorDocument, input: ApplyInput) -> Result<Vec<String>, CapabilityError> {
    ensure_project_target(document, &input.project_id)?;
    let logo_track = document.allocate_id("brand-logo-track");
    let logo_element = document.allocate_id("brand-logo");
    let phrase_track = document.allocate_id("brand-phrase-track");
    let phrase_element = document.allocate_id("brand-phrase");
    let kit = input.kit;
    let project = project_mut(document)?;
    let classic = project.classic.as_mut().ok_or_else(|| {
        CapabilityError::Unavailable("Brand finishing requires a Classic project".into())
    })?;
    let duration = (classic.scene_duration(&input.scene_id) * 120_000.0).round() as i64;
    if duration <= 0 {
        return Err(CapabilityError::InvalidInput(
            "Brand Kit requires a nonempty scene".into(),
        ));
    }
    let width = classic.document["settings"]["canvasSize"]["width"]
        .as_f64()
        .unwrap_or(1080.0);
    let height = classic.document["settings"]["canvasSize"]["height"]
        .as_f64()
        .unwrap_or(1920.0);
    classic
        .document
        .get_mut("settings")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| CapabilityError::InvalidInput("Invalid project settings".into()))?
        .insert(
            "background".into(),
            json!({"type":"color","color":kit.background_color}),
        );
    let scene = classic
        .document
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .and_then(|scenes| scenes.iter_mut().find(|s| s["id"] == input.scene_id))
        .ok_or_else(|| CapabilityError::InvalidInput("Brand Kit scene not found".into()))?;
    scene["appliedBrandKit"] =
        serde_json::to_value(&kit).map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
    let tracks = scene
        .get_mut("tracks")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| CapabilityError::InvalidInput("Invalid scene tracks".into()))?;
    let overlays = tracks
        .get_mut("overlay")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| CapabilityError::InvalidInput("Invalid overlay tracks".into()))?;
    let removed: Vec<Value> = overlays
        .iter()
        .filter(|t| t["brandKitOwner"] == "brand-kit-v1")
        .map(|t| t["id"].clone())
        .collect();
    overlays.retain(|t| t["brandKitOwner"] != "brand-kit-v1");
    for track in overlays.iter_mut() {
        let caption = track.get("captionSource").is_some();
        if let Some(settings) = track
            .get_mut("captionSource")
            .and_then(|source| source.get_mut("settings"))
            .and_then(Value::as_object_mut)
        {
            settings.insert("accentColor".into(), json!(kit.secondary_color));
        }
        if let Some(elements) = track.get_mut("elements").and_then(Value::as_array_mut) {
            for element in elements {
                if element["type"] == "text" {
                    let params = element
                        .get_mut("params")
                        .and_then(Value::as_object_mut)
                        .ok_or_else(|| {
                            CapabilityError::InvalidInput("Invalid text parameters".into())
                        })?;
                    params.insert(
                        "fontFamily".into(),
                        json!(if caption {
                            &kit.body_font
                        } else {
                            &kit.heading_font
                        }),
                    );
                    params.insert("color".into(), json!(kit.primary_color));
                    params.insert("gradientStartColor".into(), json!(kit.primary_color));
                    params.insert("gradientEndColor".into(), json!(kit.secondary_color));
                    element["captionAccentColor"] = json!(kit.secondary_color);
                    let family = if caption {
                        &kit.body_font
                    } else {
                        &kit.heading_font
                    };
                    for key in ["wordRuns", "textRowOverrides"] {
                        if let Some(overrides) = element.get_mut(key).and_then(Value::as_array_mut)
                        {
                            for run in overrides {
                                run["accentColor"] = json!(kit.secondary_color);
                                if let Some(style) =
                                    run.get_mut("style").and_then(Value::as_object_mut)
                                {
                                    if style.contains_key("color") {
                                        style.insert("color".into(), json!(kit.secondary_color));
                                    }
                                    if style.contains_key("fontFamily") {
                                        style.insert("fontFamily".into(), json!(family));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    let mut added = Vec::new();
    if let Some(logo) = &kit.logo {
        let scale = (width * 0.22 / logo.width as f64).min(height * 0.10 / logo.height as f64);
        overlays.insert(0, json!({"id":logo_track,"type":"graphic","name":format!("{} · Logo",kit.name),"hidden":false,"brandKitOwner":"brand-kit-v1","elements":[{"id":logo_element,"type":"sticker","name":kit.name,"stickerId":logo.asset_id,"intrinsicWidth":logo.width,"intrinsicHeight":logo.height,"startTime":0,"duration":duration,"trimStart":0,"trimEnd":0,"params":{"transform.scaleX":scale,"transform.scaleY":scale,"transform.positionX":width*0.32,"transform.positionY":-height*0.38,"opacity":1}}]}));
        added.push(json!(logo_track));
    }
    if let Some(phrase) = kit.phrases.first() {
        let length = duration.min(300_000);
        overlays.insert(0,json!({"id":phrase_track,"type":"text","name":format!("{} · Closing phrase",kit.name),"hidden":false,"brandKitOwner":"brand-kit-v1","elements":[{"id":phrase_element,"type":"text","name":phrase,"startTime":duration-length,"duration":length,"trimStart":0,"trimEnd":0,"params":{"content":phrase,"fontFamily":kit.heading_font,"fontSize":width*0.045,"color":kit.secondary_color,"textAlign":"center","transform.positionX":0,"transform.positionY":-height*0.25,"opacity":1}}]}));
        added.insert(0, json!(phrase_track));
    }
    if let Some(order) = tracks.get_mut("order").and_then(Value::as_array_mut) {
        order.retain(|id| !removed.contains(id));
        for id in added.into_iter().rev() {
            order.insert(0, id);
        }
    }
    if !kit.sfx_ids.is_empty() {
        let mut index = 0;
        if let Some(audio) = tracks.get_mut("audio").and_then(Value::as_array_mut) {
            for track in audio {
                if let Some(elements) = track.get_mut("elements").and_then(Value::as_array_mut) {
                    for element in elements {
                        if element["type"] == "audio"
                            && element["sourceType"] == "library"
                            && (element.get("automaticTextTransitionsOwner").is_some()
                                || element.get("automaticWordAnimationOwner").is_some())
                        {
                            let id = &kit.sfx_ids[index % kit.sfx_ids.len()];
                            let source = *input
                                .sfx_duration_ticks
                                .get(id)
                                .filter(|n| **n > 0 && **n <= 216_000_000)
                                .ok_or_else(|| {
                                    CapabilityError::InvalidInput(
                                        "Brand SFX requires a measured source duration".into(),
                                    )
                                })?;
                            let length = element["duration"].as_i64().unwrap_or(0).min(source);
                            element["libraryAssetId"] = json!(id);
                            element["name"] = json!(format!("{} · SFX", kit.name));
                            element["sourceDuration"] = json!(source);
                            element["duration"] = json!(length);
                            element["trimStart"] = json!(0);
                            element["trimEnd"] = json!(source - length);
                            index += 1;
                        }
                    }
                }
            }
        }
    }
    project.settings = classic.settings()?;
    Ok(vec![input.project_id, input.scene_id, kit.id])
}
