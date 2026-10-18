//! Pure persistence policy over stdin/stdout. No filesystem, network or MCP
//! access. A separate native process keeps large archive validation away from
//! the HTTP event loop and the WebAssembly 32-bit address-space limit.
use opencut_editor_agent::session_store::{SessionRequest, session_transition_json};
use serde::Deserialize;
use std::io::{Read, Write};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    record: String,
    account_id: String,
    project_id: String,
    request: SessionRequest,
    now_ms: u64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    const MAX_INPUT: u64 = 256 * 1024 * 1024;
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(MAX_INPUT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_INPUT {
        return Err("session policy input exceeds its limit".into());
    }
    let input: Input = serde_json::from_slice(&bytes)?;
    drop(bytes);
    let result = session_transition_json(
        &input.record,
        &input.account_id,
        &input.project_id,
        input.request,
        input.now_ms,
    )?;
    std::io::stdout().write_all(result.as_bytes())?;
    Ok(())
}
