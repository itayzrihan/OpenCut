use super::*;
use opencut_editor_agent::session_store::SessionRecord;

/// Authenticated host persistence transition; not part of the model tool set.
#[wasm_bindgen(js_name=sessionStoreTransition)]
pub fn session_store_transition(record:String,account_id:String,project_id:String,request:JsValue,now_ms:f64)->Result<JsValue,JsValue>{
    if !now_ms.is_finite() || now_ms<0.0 || now_ms.fract()!=0.0{return Err(js_error("Invalid host time"));}
    let request=from_json_input(request)?;
    let mut record=if record.is_empty(){SessionRecord::new(account_id.clone(),project_id.clone())}else{SessionRecord::from_json(&account_id,&project_id,&record)}.map_err(js_error)?;
    let result=record.apply(&account_id,&project_id,request,now_ms as u64).map_err(js_error)?;
    to_json_js(&serde_json::json!({"record":record.to_json().map_err(js_error)?,"project":record.saved.as_ref().map(|saved|&saved.project),"result":result}))
}
