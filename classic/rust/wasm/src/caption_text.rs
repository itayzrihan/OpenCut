//! Browser ABI only. Caption authoring policy lives in the shared timeline crate.
use timeline::{CaptionTextMeasureQuery, build_caption_text_element, rebuild_caption_scene};
use wasm_bindgen::{JsCast, prelude::*};

#[wasm_bindgen(typescript_custom_section)]
const CAPTION_TEXT_TYPES: &str = r#"
export interface CaptionTextMeasureQuery {
    text: string;
    font: string;
    letterSpacing: number;
}
export function buildCaptionText(options: {
    inputJson: string;
    measure?: ((query: CaptionTextMeasureQuery) => number) | null;
}): string;
export function rebuildCaptionScene(options: {
    inputJson: string;
    freshId: () => string;
    measure?: ((query: CaptionTextMeasureQuery) => number) | null;
}): string;
"#;

fn read_input(options: &JsValue) -> Result<serde_json::Value, JsValue> {
    let input_json = js_sys::Reflect::get(options, &JsValue::from_str("inputJson"))?
        .as_string()
        .ok_or_else(|| JsValue::from_str("Caption inputJson is required"))?;
    serde_json::from_str(&input_json)
        .map_err(|_| JsValue::from_str("Invalid caption builder input"))
}
fn measure(function: &js_sys::Function, query: &CaptionTextMeasureQuery) -> Result<f64, String> {
    let value = serde_wasm_bindgen::to_value(query)
        .map_err(|_| "Invalid caption measurement request".to_owned())?;
    function
        .call1(&JsValue::UNDEFINED, &value)
        .map_err(|_| "Caption measurement failed".to_owned())?
        .as_f64()
        .ok_or_else(|| "Caption measure must return a number".to_owned())
}

#[wasm_bindgen(js_name = buildCaptionText, skip_typescript)]
pub fn build_caption_text(options: JsValue) -> Result<String, JsValue> {
    let input = read_input(&options)?;
    let callback = js_sys::Reflect::get(&options, &JsValue::from_str("measure"))?;
    let result = if callback.is_undefined() || callback.is_null() {
        build_caption_text_element(&input, None)
    } else {
        let function = callback
            .dyn_into::<js_sys::Function>()
            .map_err(|_| JsValue::from_str("Caption measure must be a function"))?;
        let mut measure = |query: &CaptionTextMeasureQuery| measure(&function, query);
        build_caption_text_element(&input, Some(&mut measure))
    }
    .map_err(|error| JsValue::from_str(&error))?;
    serde_json::to_string(&result)
        .map_err(|_| JsValue::from_str("Caption result could not be serialized"))
}

#[wasm_bindgen(js_name = rebuildCaptionScene, skip_typescript)]
pub fn rebuild_caption_scene_host(options: JsValue) -> Result<String, JsValue> {
    let input = read_input(&options)?;
    let allocate = js_sys::Reflect::get(&options, &JsValue::from_str("freshId"))?
        .dyn_into::<js_sys::Function>()
        .map_err(|_| JsValue::from_str("Caption freshId must be a function"))?;
    let mut fresh_id = || {
        allocate
            .call0(&JsValue::UNDEFINED)
            .map_err(|_| "Caption identity allocation failed".to_owned())?
            .as_string()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Caption identity must be a nonempty string".to_owned())
    };
    let callback = js_sys::Reflect::get(&options, &JsValue::from_str("measure"))?;
    let result = if callback.is_undefined() || callback.is_null() {
        rebuild_caption_scene(&input, &mut fresh_id, None)
    } else {
        let function = callback
            .dyn_into::<js_sys::Function>()
            .map_err(|_| JsValue::from_str("Caption measure must be a function"))?;
        let mut provider = |query: &CaptionTextMeasureQuery| measure(&function, query);
        rebuild_caption_scene(&input, &mut fresh_id, Some(&mut provider))
    }
    .map_err(|error| JsValue::from_str(&error))?;
    serde_json::to_string(&result)
        .map_err(|_| JsValue::from_str("Caption result could not be serialized"))
}
