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
