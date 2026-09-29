# Internal accounts build

This is a local-host release candidate for Windows Electron and browsers using
the local OpenCut host. Remote hosted browser accounts, direct peer discovery,
and automatic merging of simultaneous edits are not implemented. Do not deploy
this host to a public interface.

## Build and run

On a Windows build machine, first prepare the pinned native detector environment
with `python classic/scripts/local-subject-framing/setup.py`. From
`classic/apps/electron`, run `bun run pack`. This builds the shared WASM,
native control plane, portable detector runtime and Electron web bundle before
producing `dist/win-unpacked`.
Run `OpenCut.exe` from that directory, keeping its resources beside it. For an
isolated web build, set `OPENCUT_BUILD_DIR=.next-accounts-electron` before building.
The packaging script accepts that same setting. `OPENCUT_MCP_BINARY` can select a
current native build when a separate development executable is already running.

No database, Redis, or hosted authentication service is required. Optional
hosted integrations retain their existing environment configuration. Analytics
loads only when `OPENCUT_ENABLE_TELEMETRY=true` is explicitly configured.
The Windows package includes its own Python, OpenCV, MediaPipe and pose model for
local subject detection; it does not depend on the developer's Python installation.
The optional native whisper.cpp acceleration path still requires its separately
configured binary/model/ffmpeg; browser transcription remains available.

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
3. Open Account & storage and run the drive import. Missing sources stay as
   offline references; projects, settings, metadata and history still import.
   All available files are copied into an empty account and hash-verified before
   activation. Cancellation retains staging. Original files stay untouched.
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

Choose **Local only**, **External drive**, or **My machines** in Account & storage.
For external storage, choose an existing folder on a drive or in a provider's local
synced folder. For your machines, choose a local shared folder on its host or a
mounted share hosted by one of your other computers. No provider account
or central OpenCut storage service is required. The folder contains an encrypted
vault separated by account ID. The application always keeps a local workspace.

Save a snapshot manually or enable automatic snapshots, which check for changed
work every five minutes while the client is open. Snapshot publication does not
block editor saves. Changes during a transfer invalidate that snapshot instead
of publishing inconsistent files; automatic mode retries on its next check.

Download the password-protected account recovery file. On another machine,
recover that identity, connect the same folder/share, and open a saved version.
Name each machine when connecting. The vault lists its verified device identities
and shows which machine saved each version. Device names and public identity
records are encrypted in the vault and signed by a separate key kept on that
machine. "Last connection or save" is historical activity, not live availability.
The device list does not revoke an account recovery file or a copied vault key.
OS folder sharing must already be configured; OpenCut does not expose a network
server or change your sharing permissions. If the drive or host is disconnected,
storage settings remain accessible and local editing continues; reconnect the
destination or switch to Local only.
Before switching a nonempty workspace, OpenCut saves its current version and
retains its local directory. Concurrent versions remain separate. Restore checks
every encrypted object before activation; an interrupted activation has a journal
and recovers the previous workspace after restart. Keep the recovery file and
password independently of the encrypted drive.

Select **Open projects without downloading source media** before opening a saved
version to edit on another machine without the large source files. Timeline cuts,
effects and history remain editable; the preview and timeline mark offline media.
Use **Link missing files** above the preview and paste the original file's absolute
path on that machine. Relinking retains asset IDs, timing and unknown metadata.
**Undo last relink** remains available after restart. Replacement files must match
the original type and size. Export requires the referenced source files.
Opening the full saved version later restores its media and its saved edits; it
does not merge edits made since that version. Save current work before switching.

Change a temporary password in Account & storage. Other local sessions are
invalidated; existing encrypted recovery files retain their original password.

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
- The packaged subject detector processed three frames using its isolated,
  bundled Python runtime; anonymous requests were rejected. The standalone
  bundle contains no private `.local` recovery files or `.env` files.
- Cross-account HTTP access, pinned account URLs, ranges and private library
  delivery pass; anonymous requests cannot access private data.
- Shared Rust account policy and Editor API revision/dry-run/undo tests pass.
- Personal-machine storage passes the same canonical policy and registry round
  trip. Distinct device identities survive account recovery; forged device records
  and records from another account are rejected, and disconnected drives leave
  storage settings usable.
- Synthetic two-host encrypted identity transfer restores exact project bytes
  using the packaged standalone server without hosted infrastructure.
- Recovery tests cover both versions, corruption, cancellation, concurrent edits,
  interrupted activation, structured-clone values and portable preferences.
- The pre-account backup restore rehearsal verified 2,763 files / 29,662,690,232
  bytes. A separate 154-file library/font staging copy was also hash-verified.

The owner's original missing linked clip can remain offline during migration.
Track each actual owner import using its private migration receipt and browser
archive manifests; no personal data or credentials belong in this repository or
test package. Preserve original data and the recovery tag throughout testing.
