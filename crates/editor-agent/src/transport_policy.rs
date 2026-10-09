//! Provider transport recovery policy. Hosts wait/send; no partial model
//! response may become an editor action. Never use this for host-effect retries.
use crate::AgentError;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Failure {
    attempt: u8,
    kind: String,
    #[serde(default)]
    status: Option<u16>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    retry_after_ms: Option<u64>,
    #[serde(default)]
    response_applied: bool,
}
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Plan {
    retry: bool,
    delay_ms: u64,
    max_attempts: u8,
}
pub fn provider_retry_plan(value: Value) -> Result<Value, AgentError> {
    let f: Failure =
        serde_json::from_value(value).map_err(|e| AgentError::Invalid(e.to_string()))?;
    if f.attempt == 0
        || f.attempt > 5
        || f.kind.len() > 40
        || f.code.as_ref().is_some_and(|v| v.len() > 80)
        || f.message.as_ref().is_some_and(|v| v.len() > 2000)
    {
        return Err(AgentError::Invalid(
            "Invalid provider transport failure".into(),
        ));
    }
    let code = f.code.as_deref().unwrap_or("");
    let temporary = matches!(
        code,
        "server_error" | "overloaded" | "rate_limit_exceeded" | "temporarily_unavailable"
    ) || f.message.as_deref().is_some_and(|v| {
        v.trim()
            .eq_ignore_ascii_case("Our servers are currently overloaded. Please try again later.")
    });
    let transient = match f.kind.as_str() {
        "disconnect" => true,
        "http" => matches!(f.status, Some(408 | 429 | 500 | 502 | 503 | 504)),
        "providerFailure" => temporary,
        _ => false,
    };
    let denied = f.response_applied
        || matches!(
            code,
            "insufficient_quota"
                | "invalid_api_key"
                | "authentication_error"
                | "permission_denied"
                | "model_not_found"
        )
        || matches!(f.status, Some(400 | 401 | 403 | 404));
    let max_attempts = if f.kind == "disconnect" { 3 } else { 5 };
    let retry = !denied && transient && f.attempt < max_attempts;
    let delay_ms = if retry {
        f.retry_after_ms
            .unwrap_or(1000u64 << (f.attempt - 1))
            .clamp(500, 15_000)
    } else {
        0
    };
    serde_json::to_value(Plan {
        retry,
        delay_ms,
        max_attempts,
    })
    .map_err(|e| AgentError::Invalid(e.to_string()))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn bounded_transport_recovery_never_retries_applied_protocol_or_authority_errors() {
        assert_eq!(
            provider_retry_plan(
                json!({"attempt":1,"kind":"providerFailure","code":"server_error"})
            )
            .unwrap()["delayMs"],
            1000
        );
        assert_eq!(
            provider_retry_plan(
                json!({"attempt":4,"kind":"http","status":503,"retryAfterMs":999999})
            )
            .unwrap()["delayMs"],
            15000
        );
        assert_eq!(provider_retry_plan(json!({"attempt":2,"kind":"providerFailure","message":"Our servers are currently overloaded. Please try again later."})).unwrap()["retry"],true);
        for request in [
            json!({"attempt":5,"kind":"http","status":503}),
            json!({"attempt":3,"kind":"disconnect"}),
            json!({"attempt":1,"kind":"http","status":401}),
            json!({"attempt":1,"kind":"http","status":429,"code":"insufficient_quota"}),
            json!({"attempt":1,"kind":"providerFailure","code":"server_error","responseApplied":true}),
            json!({"attempt":1,"kind":"protocol"}),
            json!({"attempt":1,"kind":"providerFailure","message":"Provider stopped"}),
        ] {
            assert_eq!(provider_retry_plan(request).unwrap()["retry"], false);
        }
        assert!(provider_retry_plan(json!({"attempt":0,"kind":"disconnect"})).is_err());
    }
}
