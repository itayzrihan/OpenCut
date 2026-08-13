use opencut_editor_api::{AccessLevel, AccessPolicy, OpenCutRuntime};
use opencut_mcp::{
    OpenCutMcp, default_classic_bridge_config_path, serve_runtime_authenticated_http,
    spawn_classic_bridge,
};
use rmcp::{ServiceExt, transport::stdio};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // MCP stdio reserves stdout exclusively for protocol frames.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let runtime = OpenCutRuntime::new(access_policy_from_env()?)?;
    let mut arguments = std::env::args().skip(1);
    match arguments.next() {
        Some(mode) if mode == "--http" => {
            let address = arguments
                .next()
                .ok_or("--http requires a loopback address such as 127.0.0.1:32123")?
                .parse()?;
            if arguments.next().is_some() {
                return Err("unexpected arguments after the HTTP address".into());
            }
            let token = std::env::var("OPENCUT_MCP_HTTP_TOKEN")
                .map_err(|_| "OPENCUT_MCP_HTTP_TOKEN is required for HTTP transport")?;
            tracing::info!(%address, "starting authenticated OpenCut MCP server");
            serve_runtime_authenticated_http(runtime, address, token).await?;
            return Ok(());
        }
        Some(mode) => return Err(format!("unknown argument `{mode}`; expected --http").into()),
        None => {}
    }

    let bridge_address = std::env::var("OPENCUT_CLASSIC_BRIDGE_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:0".into())
        .parse()?;
    let classic_bridge = if std::env::var_os("OPENCUT_CLASSIC_BRIDGE_DISABLED").is_none() {
        let bridge = spawn_classic_bridge(
            &runtime,
            bridge_address,
            default_classic_bridge_config_path(),
        )
        .await?;
        tracing::info!(
            address = %bridge.address(),
            "OpenCut Classic browser bridge is ready"
        );
        Some(bridge)
    } else {
        None
    };

    let server = OpenCutMcp::from_runtime(&runtime);
    tracing::info!("starting OpenCut MCP server over stdio");

    let service = server.serve(stdio()).await?;
    service.waiting().await?;
    drop(classic_bridge);
    Ok(())
}

fn access_policy_from_env() -> Result<AccessPolicy, Box<dyn std::error::Error>> {
    let mut policy = AccessPolicy::full_local_access();
    if let Ok(value) = std::env::var("OPENCUT_MCP_MAX_ACCESS") {
        policy.max_access = match value.to_ascii_lowercase().as_str() {
            "read" => AccessLevel::Read,
            "write" => AccessLevel::Write,
            "destructive" => AccessLevel::Destructive,
            "admin" => AccessLevel::Admin,
            _ => {
                return Err(format!(
                    "OPENCUT_MCP_MAX_ACCESS must be read, write, destructive, or admin; got `{value}`"
                )
                .into());
            }
        };
    }
    if let Some(allow) = comma_separated_env("OPENCUT_MCP_ALLOW") {
        policy.allow = allow;
    }
    if let Some(deny) = comma_separated_env("OPENCUT_MCP_DENY") {
        policy.deny = deny;
    }
    Ok(policy)
}

fn comma_separated_env(name: &str) -> Option<Vec<String>> {
    std::env::var(name).ok().map(|value| {
        value
            .split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect()
    })
}
