# Hosted release compatibility

The web editor and `opencut-session-policy` share the canonical Rust archive
contract. Deploy both from the same source revision. The native policy validates
every saved archive; inheriting an older binary from a previous release can make
the updated editor unable to save even when `/api/health` returns 200.

On the Linux build host, from the exact release source:

```sh
cargo build --locked --release -p opencut-mcp-server --bin opencut-session-policy
install -m 755 target/release/opencut-session-policy "$release/bin/opencut-session-policy"
```

When using `CARGO_TARGET_DIR`, install the binary from that target directory
instead. Include `bin/opencut-session-policy` and its SHA-256 in the release
manifest. Do not copy it unchanged from the previous release. Production uses
`/srv/pocut/live/bin/opencut-session-policy`; a candidate service must explicitly
use its candidate release's binary. Switching or rolling back the `live` symlink
then keeps server and browser contracts together.

Before activating a candidate, run this mandatory offline gate against the
candidate's exact binary:

```sh
node classic/deploy/bluehost/verify-session-policy.mjs \
  "$release/bin/opencut-session-policy"
```

The verifier and `session-policy-v6.fixture.json` can also be copied together to
the deployment host; an optional second argument selects the fixture path. They
require only Node and the candidate binary, and never access account storage or
the network. A nonzero exit blocks activation. Preserve the final JSON receipt
with binary and fixture hashes in release verification evidence.

The fixture contains synthetic Hebrew/Arabic timed script rows, an independently
stored Latin transliteration, immutable row versions, an approved image reference
and a Director handoff. The gate saves and reopens full/base/chained schema-v6
archives, compares the complete archive including undo/redo boundaries, checks
idempotent save retries, rejects a different account and an obsolete editor
owner, and rejects malformed production state. Each transition runs a new native
process, matching the server persistence boundary. No provider call is made.

Regenerate the fixture after relevant contract changes, using the newly built
browser WASM, then review and commit it:

```sh
node classic/deploy/bluehost/generate-session-policy-fixture.mjs
```

Its `wasmSha256` identifies the actual generator runtime. Keep browser integration
tests for runtime restore and Undo/Redo as well; an HTTP health check or a schema
parse alone does not prove that the server can persist the browser's current
project format.
