use super::*;
use opencut_editor_agent::session_store::session_transition_json;

/// Authenticated host persistence transition; not part of the model tool set.
#[wasm_bindgen(js_name=sessionStoreTransition)]
pub fn session_store_transition(
    record: String,
    account_id: String,
    project_id: String,
    request: JsValue,
    now_ms: f64,
) -> Result<JsValue, JsValue> {
    if !now_ms.is_finite() || now_ms < 0.0 || now_ms.fract() != 0.0 {
        return Err(js_error("Invalid host time"));
    }
    let result = session_transition_json(
        &record,
        &account_id,
        &project_id,
        from_json_input(request)?,
        now_ms as u64,
    )
    .map_err(js_error)?;
    js_sys::JSON::parse(&result)
}
