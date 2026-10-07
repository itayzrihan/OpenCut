use super::*;
use opencut_editor_agent::knowledge::{KnowledgeAuthority,KnowledgeStore};

/// Host storage boundary. Identity and owned project IDs are supplied by the
/// authenticated server, not accepted inside the model/UI request protocol.
#[wasm_bindgen(js_name = knowledgeDispatch)]
pub fn knowledge_dispatch(store:String,account_id:String,project_id:String,owned_projects:JsValue,request:JsValue,now_ms:f64)->Result<JsValue,JsValue>{
    let owned_projects=serde_wasm_bindgen::from_value(owned_projects).map_err(js_error)?;
    let request=serde_wasm_bindgen::from_value(request).map_err(js_error)?;
    if !now_ms.is_finite() || now_ms<0.0 {return Err(js_error("Invalid host time"));}
    let mut store=if store.is_empty(){KnowledgeStore::new(account_id.clone())}else{KnowledgeStore::from_json(&account_id,&store)}.map_err(js_error)?;
    let result=store.dispatch(&KnowledgeAuthority{account_id,project_id,owned_projects},request,now_ms as u64).map_err(js_error)?;
    to_js(&serde_json::json!({"store":store.to_json().map_err(js_error)?,"result":result}))
}
