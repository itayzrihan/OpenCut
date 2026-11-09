# Legitate local sign-in (in progress)

Classic-only integration. Legitate uses issuer `https://auth.legitate.com` and
the public OIDC client `opencut-local`, authorization code plus PKCE S256. The
identity server must register the exact local callback origins for each host and
port; a Legitate application-catalog entry alone does not register an OIDC
client. Do not put client secrets or identity records into the repository.

`OPENCUT_LEGITATE_CLIENT_ID` enables the sign-in and existing-workspace linking
controls. The first link must start from an already authenticated local account;
only a verified Legitate issuer and opaque subject can create the binding. The
binding under the shared accounts root preserves the existing account ID and
therefore its project data. Existing bindings cannot silently be replaced by a
different account or subject. A browser-bound, one-use authorization
transaction expires after five minutes. The local browser session cookie is not
the Legitate access token.

After a real link and subsequent sign-in have both been tested, set
`OPENCUT_LEGITATE_ONLY=true` on **both** the development and local production
server. This rejects pre-existing password sessions and local login, account
registration, recovery, and password changes. Plan the restart around active
editors; a currently open editor will need to sign in again. Local production
reads runtime variables from `~/Library/Application Support/OpenCut Local/runtime.env`.
Keep the existing release and data for rollback. Do not activate this flag until
the exact production build and account binding have been verified.

The OIDC client must be maintained in the identity server's deployment source;
a manually changed running configuration is not sufficient for durable rollout.

## Hosted PoCut sign-in

The browser deployment sets `OPENCUT_LEGITATE_HOSTED=true`,
`OPENCUT_LEGITATE_ONLY=true`, and `OPENCUT_PUBLIC_ORIGIN` to its exact HTTPS
origin. Use a public PKCE client with the exact
`/api/accounts/legitate/callback` URL and the `openid` scope. PoCut on
`https://pocut.vxu.me` uses the Legitate client `pocut-web`.

A verified Legitate issuer and subject resolve to a stable account namespace.
Each subject has separate workspace data. Keep `OPENCUT_ACCOUNTS_DIR` on a
persistent volume and bind the Next server to loopback behind the HTTPS
reverse proxy. Preserve the external host and overwrite forwarded protocol
headers at that proxy. Publish the browser API allowlist and keep host tools,
desktop callbacks, and the MCP bridge on private interfaces.
