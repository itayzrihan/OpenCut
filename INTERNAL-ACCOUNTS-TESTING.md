# Internal accounts build

This is a local-host release candidate for Windows Electron and browsers using
the local OpenCut host. Remote hosted browser accounts, direct peer discovery,
and automatic merging of simultaneous edits are not implemented. Do not deploy
this host to a public interface.

## Build and run

From `classic/apps/electron`, run `bun run pack`. This builds the shared WASM,
native control plane, and Electron web bundle before producing `dist/win-unpacked`.
Run `OpenCut.exe` from that directory, keeping its resources beside it. For an
isolated web build, set `OPENCUT_BUILD_DIR=.next-accounts-electron` before building.
The packaging script accepts that same setting. `OPENCUT_MCP_BINARY` can select a
current native build when a separate development executable is already running.

No database, Redis, or hosted authentication service is required. Optional
hosted integrations retain their existing environment configuration. Analytics
loads only when `OPENCUT_ENABLE_TELEMETRY=true` is explicitly configured.

For a clean test installation, set `OPENCUT_ACCOUNTS_DIR` to a new test folder,
`POCUT_PROJECTS_DIR` to an empty test legacy folder, and
`OPENCUT_LEGACY_PUBLIC_DIR` to an empty test asset folder before launching.
Do not point synthetic accounts at personal legacy data.

The packaged native MCP executable is under `resources/control-plane`.
Configure MCP clients to launch this executable over stdio. Account builds
require bridge descriptor version 2; older running bridge instances are ignored
because they do not enforce the new session-completion ownership checks.

## Preserve and import existing work

1. Keep the pre-account Git tag and verified external backup. Do not delete the
   original projects or browser profiles after importing.
2. Create the owner's account first. Only that account receives the legacy
   import grant. Every subsequent account starts with an isolated workspace.
3. Open Account & storage. Resolve every missing linked file listed by the
   inventory before running the drive import. Import copies into an empty
   account and verifies hashes before activation. Cancellation retains staging.
4. After drive import completes, run Copy legacy browser data in each browser
   profile and origin previously used. This first archives the original browser
   databases, binary values, OPFS media and preferences into the account, with
   byte verification. It then copies the editable browser stores. Conflicting
   project IDs become separately named browser recovery projects. Originals stay
   in place, and exact source documents/history remain in the recovery copy.
5. Review representative timelines, undo history, source media, fonts, captions,
   saved libraries and settings before considering migration accepted.

Packaged installations also discover preserved legacy assets in
`~/Movies/OpenCut Legacy Assets`. The development checkout's private recovery
folder is a fallback. These files are user data and are never packaged or pushed.

## External storage and multiple machines

Choose an existing folder on an external drive, in a provider's local synced
folder, or on a mounted share hosted by one of your machines. No provider account
or central OpenCut storage service is required. The folder contains an encrypted
vault separated by account ID. The application always keeps a local workspace.

Save a snapshot manually or enable automatic snapshots, which check for changed
work every five minutes while the client is open. Snapshot publication does not
block editor saves. Changes during a transfer invalidate that snapshot instead
of publishing inconsistent files; automatic mode retries on its next check.

Download the password-protected account recovery file. On another machine,
recover that identity, connect the same folder/share, and open a saved version.
Before switching a nonempty workspace, OpenCut saves its current version and
retains its local directory. Concurrent versions remain separate. Restore checks
every encrypted object before activation; an interrupted activation has a journal
and recovers the previous workspace after restart. Keep the recovery file and
password independently of the encrypted drive.

## Client inference

Sounds → Voiceover generates English speech with Kokoro on WebGPU when available,
or in CPU compatibility mode. Public weights and voices cache in the client;
the first use needs an internet connection. Generated audio enters the existing
project media/undo path. Hebrew voices are not part of this implementation.

GPU and CPU generation, cancellation and media import passed in the browser.
The Electron renderer and its WebGPU adapter passed a smoke check. A further
Electron GPU generation/offline integration command was blocked by automatic
approval review, so generation after an Electron restart without internet remains
an explicit internal testing check, not a verified claim.

## Acceptance evidence and remaining gates

- Production browser/Electron web builds and Windows unpacked packaging pass.
- Cross-account HTTP access, pinned account URLs, ranges and private library
  delivery pass; anonymous requests cannot access private data.
- Shared Rust account policy and Editor API revision/dry-run/undo tests pass.
- Synthetic two-host encrypted identity transfer restores exact project bytes
  using the packaged standalone server without hosted infrastructure.
- Recovery tests cover both versions, corruption, cancellation, concurrent edits,
  interrupted activation, structured-clone values and portable preferences.
- The pre-account backup restore rehearsal verified 2,763 files / 29,662,690,232
  bytes. A separate 154-file library/font staging copy was also hash-verified.

The owner's original missing linked clip is still unresolved. The actual owner
account has not been created or migrated, and the owner browser profiles have not
yet completed the logical import. Those are required before declaring the owner's
migration complete. Preserve the original data and the recovery tag throughout
internal testing.
