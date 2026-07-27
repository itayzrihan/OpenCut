use background_removal::{
    BackgroundRemovalSettings, DuplicatePlacementInput, plan_duplicate_placement,
    refine_alpha_mask, resolve_settings,
};
use serde::Serialize;
use wasm_bindgen::{JsValue, prelude::wasm_bindgen};

#[wasm_bindgen(js_name = defaultBackgroundRemovalSettings)]
pub fn default_background_removal_settings() -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&BackgroundRemovalSettings::default())
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen(js_name = resolveBackgroundRemovalSettings)]
pub fn resolve_background_removal_settings(value: JsValue) -> Result<JsValue, JsValue> {
    let settings: BackgroundRemovalSettings = serde_wasm_bindgen::from_value(value)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    // `ResolvedBackgroundRemovalSettings` flattens its normalized settings into
    // the response. Serde represents that flattened portion as a map, so the
    // default serializer would expose it as a JavaScript `Map` instead of the
    // plain object consumed by the web app.
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    resolve_settings(settings)
        .serialize(&serializer)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen(js_name = planBackgroundRemovalDuplicate)]
pub fn plan_background_removal_duplicate(value: JsValue) -> Result<JsValue, JsValue> {
    let input: DuplicatePlacementInput = serde_wasm_bindgen::from_value(value)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let placement = plan_duplicate_placement(&input)
        .map_err(|error| JsValue::from_str(&format!("{error:?}")))?;
    serde_wasm_bindgen::to_value(&placement).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen(js_name = refineBackgroundAlpha)]
pub fn refine_background_alpha(
    current: &[u8],
    previous: &[u8],
    mask_threshold: f32,
    edge_contrast: f32,
    temporal_smoothing: f32,
) -> Vec<u8> {
    refine_alpha_mask(
        current,
        previous,
        mask_threshold,
        edge_contrast,
        temporal_smoothing,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use background_removal::{TrackKind, TrackSummary};
    use js_sys::{Map, Object, Reflect};
    use wasm_bindgen::JsCast;
    use wasm_bindgen_test::wasm_bindgen_test;

    #[wasm_bindgen_test]
    fn resolved_settings_are_a_flat_javascript_object() {
        let defaults = default_background_removal_settings().unwrap();
        let resolved = resolve_background_removal_settings(defaults).unwrap();

        assert!(!resolved.is_instance_of::<Map>());
        let object = resolved.unchecked_into::<Object>();
        assert_eq!(Object::keys(&object).length(), 12);
        assert_eq!(
            Reflect::get(&object, &JsValue::from_str("quality"))
                .unwrap()
                .as_string()
                .as_deref(),
            Some("balanced")
        );
        assert_eq!(
            Reflect::get(&object, &JsValue::from_str("inputSize"))
                .unwrap()
                .as_f64(),
            Some(384.0)
        );
        assert!(
            Reflect::get(&object, &JsValue::from_str("settings"))
                .unwrap()
                .is_undefined()
        );
    }

    #[wasm_bindgen_test]
    fn duplicate_placements_use_camel_case_javascript_fields() {
        let existing_track = duplicate_placement_for_track_above(TrackKind::Video);
        assert_eq!(
            Reflect::get(&existing_track, &JsValue::from_str("kind"))
                .unwrap()
                .as_string()
                .as_deref(),
            Some("existingTrack")
        );
        assert_eq!(
            Reflect::get(&existing_track, &JsValue::from_str("trackId"))
                .unwrap()
                .as_string()
                .as_deref(),
            Some("above")
        );
        assert!(
            Reflect::get(&existing_track, &JsValue::from_str("track_id"))
                .unwrap()
                .is_undefined()
        );

        let new_track = duplicate_placement_for_track_above(TrackKind::Text);
        assert_eq!(
            Reflect::get(&new_track, &JsValue::from_str("kind"))
                .unwrap()
                .as_string()
                .as_deref(),
            Some("newTrack")
        );
        assert_eq!(
            Reflect::get(&new_track, &JsValue::from_str("insertIndex"))
                .unwrap()
                .as_f64(),
            Some(1.0)
        );
        assert!(
            Reflect::get(&new_track, &JsValue::from_str("insert_index"))
                .unwrap()
                .is_undefined()
        );
    }

    fn duplicate_placement_for_track_above(track_type: TrackKind) -> JsValue {
        let input = DuplicatePlacementInput {
            source_track_index: 1,
            source_start_time: 100.0,
            source_duration: 50.0,
            tracks: vec![
                TrackSummary {
                    id: "above".to_owned(),
                    track_type,
                    spans: Vec::new(),
                },
                TrackSummary {
                    id: "source".to_owned(),
                    track_type: TrackKind::Video,
                    spans: Vec::new(),
                },
            ],
        };
        let value = serde_wasm_bindgen::to_value(&input).unwrap();
        plan_background_removal_duplicate(value).unwrap()
    }
}
