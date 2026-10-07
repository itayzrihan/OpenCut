//! Classic project settings. UI gestures and agent edits share validation/history.
use super::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanvasSize {
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Background {
    Color {
        color: String,
    },
    Blur {
        #[serde(rename = "blurIntensity")]
        blur_intensity: f64,
    },
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
enum CanvasMode {
    Preset,
    Custom,
}

// Distinguish an omitted property from explicitly clearing a remembered size.
fn nullable_size<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<CanvasSize>>, D::Error> {
    Option::<CanvasSize>::deserialize(deserializer).map(Some)
}

fn non_null<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsPatch {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    #[schemars(with = "Rational")]
    fps: Option<Rational>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    #[schemars(with = "CanvasSize")]
    canvas_size: Option<CanvasSize>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    #[schemars(with = "CanvasMode")]
    canvas_size_mode: Option<CanvasMode>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable_size"
    )]
    last_custom_canvas_size: Option<Option<CanvasSize>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable_size"
    )]
    original_canvas_size: Option<Option<CanvasSize>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    #[schemars(with = "Background")]
    background: Option<Background>,
}

impl SettingsPatch {
    fn validate(&self) -> Result<(), CapabilityError> {
        if let Some(rate) = &self.fps {
            rate.validate("Classic fps")
                .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
        }
        for size in [
            self.canvas_size.as_ref(),
            self.last_custom_canvas_size
                .as_ref()
                .and_then(Option::as_ref),
            self.original_canvas_size.as_ref().and_then(Option::as_ref),
        ]
        .into_iter()
        .flatten()
        {
            if size.width == 0 || size.height == 0 {
                return Err(CapabilityError::InvalidInput(
                    "canvas dimensions must be positive integers".into(),
                ));
            }
        }
        match &self.background {
            Some(Background::Color { color })
                if color.trim().is_empty() || color.len() > 65_536 =>
            {
                return Err(CapabilityError::InvalidInput(
                    "background color/gradient must contain 1 to 65536 UTF-8 bytes".into(),
                ));
            }
            Some(Background::Blur { blur_intensity })
                if !blur_intensity.is_finite() || *blur_intensity < 0.0 =>
            {
                return Err(CapabilityError::InvalidInput(
                    "background blur intensity must be finite and nonnegative".into(),
                ));
            }
            _ => {}
        }
        Ok(())
    }
}

/// Validate known optional settings on generic commits without dropping extension fields.
pub(crate) fn validate_settings(settings: &Value) -> Result<(), String> {
    let object = settings
        .as_object()
        .ok_or("Classic settings must be an object")?;
    let mut known: Map<String, Value> = object
        .iter()
        .filter(|(key, _)| {
            matches!(
                key.as_str(),
                "canvasSizeMode" | "lastCustomCanvasSize" | "originalCanvasSize" | "background"
            )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    // Existing documents can contain forward-compatible metadata within these
    // values. Validate known members without rejecting or stripping that data.
    for key in ["lastCustomCanvasSize", "originalCanvasSize", "background"] {
        if let Some(value) = known.get_mut(key).and_then(Value::as_object_mut) {
            value.retain(|field, _| {
                if key == "background" {
                    matches!(field.as_str(), "type" | "color" | "blurIntensity")
                } else {
                    matches!(field.as_str(), "width" | "height")
                }
            });
        }
    }
    for key in ["canvasSizeMode", "background"] {
        if known.get(key).is_some_and(Value::is_null) {
            return Err(format!("{key} cannot be null"));
        }
    }
    let patch: SettingsPatch =
        serde_json::from_value(Value::Object(known)).map_err(|e| e.to_string())?;
    patch.validate().map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsInput {
    project_id: String,
    expected_revision: u64,
    settings: SettingsPatch,
    /// Optional UI gesture ID. Only uninterrupted changes with the same ID coalesce.
    #[serde(default)]
    history_group: Option<String>,
}

pub(super) fn register_classic_settings(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    register::<SettingsInput, MutationOutput, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "project.classic.settings.update",
        "Update Classic project settings",
        "Change Classic canvas dimensions, rational FPS, color/CSS gradient or blur background, canvas preset/custom mode and remembered original/custom dimensions. Supply only changed settings; each supplied object replaces that setting. Explicit null clears remembered dimensions. Does not scale or retime clips. Preserves all other project fields/media/sources. Requires projectId and expectedRevision; supports undo/redo, dry run, exact retries and atomic transactions. Optional historyGroup coalesces an uninterrupted UI gesture into one undo boundary; agent edits normally omit it. Every preview remains a validated committed revision, and any intervening edit or undo breaks coalescing.",
        "project",
        AccessLevel::Write,
        false,
        false,
        &[
            "classic",
            "settings",
            "canvas",
            "resolution",
            "fps",
            "background",
            "color",
            "blur",
        ],
        move |context, input| {
            let state = state.clone();
            let events = events.clone();
            async move {
                input.settings.validate()?;
                if input
                    .history_group
                    .as_ref()
                    .is_some_and(|id| id.trim().is_empty() || id.len() > 160)
                {
                    return Err(CapabilityError::InvalidInput(
                        "historyGroup must contain 1 to 160 UTF-8 bytes".into(),
                    ));
                }
                let updates = serde_json::to_value(input.settings)
                    .map_err(|e| CapabilityError::Failed(e.to_string()))?;
                let updates = updates.as_object().unwrap();
                if updates.is_empty() {
                    return Err(CapabilityError::InvalidInput(
                        "supply at least one project setting".into(),
                    ));
                }
                let now = super::classic_scenes::timestamp()?;
                let group = input
                    .history_group
                    .map(|id| format!("classic-settings:{id}"));
                let output = mutate_grouped(
                    &state,
                    &events,
                    &context,
                    "Update project settings",
                    Some(input.expected_revision),
                    group.as_deref(),
                    |document| {
                        let project = project_mut(document)?;
                        if project.id != input.project_id {
                            return Err(CapabilityError::Conflict(
                                "settings target project is not active".into(),
                            ));
                        }
                        let classic = project.classic.as_mut().ok_or_else(|| {
                            CapabilityError::Unavailable(
                                "Classic settings require a Classic project".into(),
                            )
                        })?;
                        let settings = classic
                            .document
                            .get_mut("settings")
                            .and_then(Value::as_object_mut)
                            .ok_or_else(|| {
                                CapabilityError::InvalidInput("invalid Classic settings".into())
                            })?;
                        settings.extend(updates.clone());
                        classic.document.get_mut("metadata").unwrap()["updatedAt"] =
                            Value::String(now);
                        project.settings = classic
                            .settings()
                            .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                        Ok(vec![input.project_id])
                    },
                )?;
                Ok(OperationSuccess::new(output)
                    .summary("Updated Classic project settings")
                    .changed([STATE_RESOURCE, PROJECT_RESOURCE, TIMELINE_RESOURCE]))
            }
        },
    )
}
