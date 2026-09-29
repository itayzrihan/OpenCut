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
MCP and all server-side AI endpoints are not accessible through this deployment.
Native file paths and linked media refer to the host computer. Browser uploads
come from the device visiting the site. TTS inference runs in that browser.

## Per-device OpenAI connection

Remote browsers now send every AI request to the user's own loopback companion
at `127.0.0.1:43127`. They never retry against the hosting server. Build the
Windows companion with `classic/scripts/build-client-ai.ps1` and copy the
resulting `OpenCut-AI-Windows.zip` into the deployment's `public/downloads`.
The AI panel guides users through downloading the app and an account-specific
pairing file generated in their browser. No Node/Bun/CLI installation is needed.

The pairing secret is kept in account-scoped sessionStorage and a user-downloaded
local configuration file; it is not sent to the hosting server. The companion
checks exact Origin, Host, account ID and a random 256-bit bearer capability.
It has only AI endpoints, no editor, filesystem, shell or MCP API. It uses the
existing Codex OAuth/Responses transport, with its registered localhost:1455
callback, on the client computer. Its encrypted credentials and session cookie
jar live under LOCALAPPDATA/OpenCut Client AI, partitioned by app origin and
OpenCut account. It never imports another Codex/Desktop login automatically.
The browser never receives the OpenAI access/refresh tokens.

Closing the companion stops access. Switching accounts clears browser pairing;
restart the companion with the new account's pairing file. OAuth credentials
also bind to the explicit OpenCut account and app session. Legacy sessionless
credentials require a new sign-in. Local browser/Electron installations still
use their same-machine account-protected AI endpoints.

This is the client-side connection to a cloud OpenAI model, not local execution
of that model. Browser-only ChatGPT sign-in without a local runtime is not
implemented. Windows packaging, loopback kickoff and negative isolation checks
are verified; a real OpenAI login and model request require a user sign-in.

Verification: `node --test classic/scripts/tailnet-gateway.test.mjs`, followed
by HTTPS login, account/project listing, media range requests, and rejection
of unauthenticated, cross-origin, cross-account, and MCP requests against the
actual deployment. Check browser login and project display as well.
