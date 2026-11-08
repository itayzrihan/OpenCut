# Missing originals across personal devices

This feature is Classic-only. Shared transfer validation lives in
`crates/account-core`; the canonical Editor API installs six typed host
capabilities, automatically discovered by the editor agent and MCP. The rewrite
UI has no duplicate implementation.

The existing account vault uses mounted/synced folders and immutable snapshots.
Legitate login by itself does not synchronize project documents or original
files. This feature pulls missing **registered media originals** for projects
already present on both computers, using their existing project/media IDs.
It does not merge divergent project edits, synchronize a cloud project list,
or transfer standalone font-library files.

## How it works

1. Sign in and link the same Legitate identity on each computer. The first link
   starts from the existing local OpenCut workspace, preserving its account ID
   and project directory. Recovered local account IDs need not match: peer
   discovery uses the verified Legitate issuer and subject.
2. Both hosts use the deployed default relay. Administrators can override it
   with `OPENCUT_SYNC_RELAY_URL=https://<your-relay-host>`; an explicitly empty
   value disables transfers on that host. HTTPS is required outside loopback
   development. Users do not need to configure environment variables.
3. Under Account → Your storage, explicitly enable device sharing on each host.
   Sharing is off by default and belongs to that local account/device. Keep
   OpenCut open; authenticated browser heartbeats renew a two-minute host lease.
   Pausing sharing cancels active transfers and stops serving originals. Logout
   immediately disconnects that account's local host services. Cancellation also
   interrupts source-side work, including checksumming a large original.
4. Open the project and expand “Link missing files”. Choose an online computer
   and pull the missing files. Existing manual relink controls remain available.
5. Continue editing while originals download. A ready file is linked using the
   existing canonical media binding and its revision fence. The media ID and
   timeline remain unchanged; Undo last relink remains available.

Pulls stream encrypted 256 KiB chunks through an ephemeral relay. The relay
verifies signed Legitate ID tokens for issuer `https://auth.legitate.com` and
audience `opencut-local`, derives account ownership itself, and does not accept
caller-supplied user IDs. Sessions expire with the identity proof. Reconnecting
after proof expiry requires signing in through Legitate again. Browser session
cookies and project/account recovery files never contain these relay proofs.

The relay forwards ciphertext only. X25519-derived AES-256-GCM keys bind each
message to owner/sender/recipient. Discovery trusts the authenticated relay's
device-key directory; this is not out-of-band fingerprint verification against
a malicious directory operator. Each peer reads only existing media IDs from
its own account/project, never a remotely supplied path. File grants are bound
to a requesting device, expire, and reject changed source files.

Source size and media type must match the missing record. Whole-file SHA-256
verifies that the received bytes match the source's manifest. An external linked
source whose registered modification time changed must be verified/relinked on
the source host first. Original content hashes are not retroactively known for
legacy imports, so this cannot prove the pre-import history of an un-hashed file.

## Failure and recovery

Partial bytes and a pinned manifest stay under the destination account's
`peer-transfers/<project>/<operation>/` directory. Explicit resume requests the
same source digest and continues at the existing offset. Changed sources,
different operation parameters, stale bindings, unavailable peers, corrupt
chunks and insufficient free space fail without replacing existing media.
Corrupt downloads are retained separately and never linked.

The HTTP acceptance reply can be lost after staging begins. The editor replays
the exact pending invocation before listing/starting another job; operation IDs
are durable and cannot be reassigned to another file. New project/account
generations reject late publication. Staging runs outside project locks, and
final relink uses the existing editor/session/batch write fences.

Download journals and partial/corrupt bytes are excluded from account snapshots.
Verified linked originals are materialized through their media index by the
existing snapshot path, once rather than duplicating the staging cache.

## Relay deployment

Development: `node classic/scripts/peer-sync-relay.mjs` binds loopback port 3010
and still requires real Legitate proofs. There is no environment switch that
turns off production verification. Test factories inject isolated verifiers.

The dedicated container copies only the relay, launcher and pinned `jose`
dependency. It contains no account directory, project media, .env files, local
credentials, editor server or MCP endpoint. The default official Node 24 Alpine
image is pinned by OCI digest (resolved November 2, 2026). Publish a reviewed
commit before production deployment; override `NODE_IMAGE` only with a reviewed
immutable digest.

Build from the repository root:

```sh
docker build -f classic/services/peer-sync-relay/Dockerfile \
  -t opencut-peer-relay:<reviewed-commit> .
```

Expose container port 3010 through a dedicated HTTPS reverse proxy. Allow 512 KiB
request bodies and at least 30-second request timeouts for long polling. Do not
log Authorization headers or request bodies. The relay needs outbound access to
the Legitate JWKS endpoint, no persistent volume, and bounded container memory.
It caps simultaneous request bodies at 32, connections, devices, mailboxes and
total queued ciphertext at 64 MiB.
The local desktop MCP endpoint remains authenticated and loopback-only.

## Verification and activation gates

`node classic/scripts/verify-peer-media.mjs` runs native policy/registry tests,
real-WASM transfer/commit tests, account/storage regressions, production and
feature-test TypeScript, and WASM export verification. Test peers communicate
over actual loopback HTTP and transfer actual temporary files; their broker
identity proofs are test fixtures. Separate tests verify real signature/issuer/
audience/expiry checks using generated signing keys.

The dedicated relay is deployed at
`https://opencut-peer-sync.85-215-209-220.sslip.io` with verified public TLS.
The deployment source is commit `fb7cfed20e84f1b49aa379b159eac6ef39e4132f`
on `codex/peer-sync-relay-20261102`; this branch contains only the six relay
deployment files, not the complete client feature. Live health returned 200,
anonymous discovery 401, and an unverified identity 400 on November 2, 2026.
The client uses this relay by default; explicit empty configuration disables it.
Sharing remains opt-in.

After an actual Legitate sign-in, the opt-in developer acceptance command
`node classic/scripts/verify-peer-media-live.mjs --accounts-root <private-account-root>`
uses the private verified proof in memory, the production transport, two temporary
logical devices, and synthetic bytes. It writes a redacted result under
`.local/peer-sync-qa/`; it never reads project media or enables account sharing.
It deliberately targets only the deployed service and preserves TLS validation.
Its temporary peers are disconnected when the command completes.

Real Legitate linking on two computers, large-file throughput, and a live media
relink between two physical networks remain activation gates. Passing loopback
tests or the two-logical-peer public smoke does not assert those gates passed.
Project metadata must already exist on both hosts through the existing project
storage/snapshot workflow; this feature does not provide cloud project-list sync.
