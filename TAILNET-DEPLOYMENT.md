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

On Windows with Bun, dereference junctions when copying. Also materialize the
standalone `node_modules/.bun/node_modules` directory into the deployment's
root `node_modules`: copying Next's junction alone loses its sibling dependency
resolution. Verify startup from the deployed directory, outside the checkout.

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
MCP and local OAuth callback/start endpoints are not accessible through this deployment.
Only AI chat, models, status, logout, and device-code login are forwarded.
Native file paths and linked media refer to the host computer. Browser uploads
come from the device visiting the site. TTS inference runs in that browser.

## Browser OpenAI connection (no client installation)

This classic-only transport uses the official Codex app-server device-code login
through private stdio. The browser shows a one-time code and the OpenAI sign-in
link. No localhost callback, helper download, public app-server port, or browser
OpenAI token is used. The existing account-authorized Responses transport handles
model requests; OpenAI performs inference. Editor state remains in its existing
runtime; this change adds no editor state store.

Add `aiCodexBinary` (absolute native Codex executable path) and `aiPrivateRoot`
(absolute private directory) to deployment.json. Pin the native runtime in the
versioned deployment rather than using a global, auto-updating PATH command.
Verified runtime: codex-cli 0.154.0-alpha.6.2. App-server is experimental; this
integration is for internal testing, not a claim of general production support.
The device-code API is documented at https://learn.chatgpt.com/docs/app-server#auth-endpoints.

The host directory must be restricted to the deployment OS account and SYSTEM
(on Unix, mode 0700). On Windows explicitly disable inherited ACLs and grant
only those identities full control. Keep it outside Git, public assets, account
exports, and external-drive synchronization. The runner supplies it as
OPENCUT_SERVER_AI_PRIVATE_DIR and stores encrypted sessions in its `sessions`
subdirectory. Preserve the host-cookie-key in the account root on redeployment.

Each attempt runs in a fresh private CODEX_HOME, with no inherited host login,
API keys, config, MCPs, or user profiles. Only initialize and device login RPCs
are sent; no agent thread or tool execution is exposed. Codex briefly writes
its own token file in that private directory after approval. The adapter reads
that file, terminates the process tree, and removes the temporary home. OpenCut
then encrypts access/refresh tokens using AES-256-GCM. Unfinished attempts expire
after ten minutes; starts are bounded globally and per account. After a hard
host crash, remove only orphaned `login-*` directories inside aiPrivateRoot once
their processes are confirmed stopped; these directories are never imported.

Credentials bind to both the authenticated OpenCut account and its browser login
session, with an additional HttpOnly binding cookie. Switching accounts or
signing into OpenCut again requires a fresh OpenAI connection. Another device
must connect its own OpenAI login; it does not inherit this browser's tokens.
Logout revokes the stored session. Concurrent refreshes share one exchange and
cannot restore a session after logout. HTTPS cookies are Secure and HttpOnly;
responses are private/no-store. Origin and account checks run before login and
before every AI request. Browser responses are discarded after an account switch.

The previous companion implementation remains available in source for explicit
local integrations, but the deployed web UI no longer uses it. Standalone local
browser/Electron installs retain their registered loopback OAuth login.

Verification covers an actual device-code kickoff and cancel with the pinned
Codex binary, synthetic token completion/encrypted persistence/relay, cross-account
and cross-session denial, revoked refresh, CSRF, and live HTTPS account data.
Real approval and a model response with the user's OpenAI account still require
that user's sign-in; a successful kickoff alone is not an end-to-end AI test.

Verification: `node --test classic/scripts/tailnet-gateway.test.mjs`, followed
by HTTPS login, account/project listing, media range requests, and rejection
of unauthenticated, cross-origin, cross-account, and MCP requests against the
actual deployment. Check browser login and project display as well.
