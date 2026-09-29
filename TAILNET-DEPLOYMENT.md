# Local browser deployment over Tailscale

This is a classic-only deployment adapter; it does not create another editor
state store. The browser uses the same authenticated account APIs and Rust
policies as the local app. Projects and media remain in the configured account
directory on the host computer. Opening this URL on another device accesses
that host's data; it does not copy a workspace to the other device.

Build with `OPENCUT_BUILD_DIR=.next-tailnet bun run build` in `classic/apps/web`.
Copy the standalone output, its `.next-tailnet/static` directory, and public
assets into a versioned deployment directory. Exclude `.env*`, `.local`, and
runtime user data from the deployment. Never point deployment cleanup at the
account directory.

Run `classic/scripts/run-local-deployment.mjs` with the path to a local JSON
configuration containing `appRoot` (the copied `apps/web` directory),
`accountsRoot`, `publicOrigin` (an exact `https://HOST.ts.net:8444` origin),
`appPort` (3110), and `gatewayPort` (3111). Both processes bind to 127.0.0.1.
The runner restarts a child if it exits. A per-user login startup task can
launch the runner in the background; the host must remain awake and connected.

Expose only the gateway using `tailscale serve --bg --https=8444
http://127.0.0.1:3111`. Preserve any existing Serve listeners. Do not use Funnel.
To stop sharing this deployment, use `tailscale serve --https=8444 off`.

The gateway checks the exact external Host and Origin before translating
requests to the loopback app, strips forwarded headers, requires an Origin
for writes, and marks session cookies Secure. The app still authenticates
each account operation. Only explicitly listed API routes are forwarded;
MCP and local OAuth endpoints are not accessible through this deployment.
Native file paths and linked media refer to the host computer. Browser uploads
come from the device visiting the site. TTS inference runs in that browser.

Verification: `node --test classic/scripts/tailnet-gateway.test.mjs`, followed
by HTTPS login, account/project listing, media range requests, and rejection
of unauthenticated, cross-origin, cross-account, and MCP requests against the
actual deployment. Check browser login and project display as well.
