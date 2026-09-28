# Accounts and local-first release

## Recovery baseline

The complete pre-account product is commit `da75f520`, pushed to canonical
`itayzrihan/OpenCut` main and tagged `pre-accounts-2026-09-28`.
Development proceeds on `codex/accounts-local-first`.

The owner's original `PoCut Projects` directory must remain untouched by the
account importer. Import is an explicit, copy-only operation into an empty
account, with a manifest and SHA-256 verification before activation. Preserve
project IDs, every document field, history, fonts, presets, settings, media,
recovery snapshots, and batch records. Linked media must be copied into the
portable archive, with a reversible path mapping. Never mark an incomplete
import successful or silently skip a missing source.

Private recovery data and credentials must never be committed to Git. The
local recovery inventory lives outside the repository. The legacy repository
library is retained in the recovery tag; release artifacts must not distribute
the owner's personal library.

## Required release gates (work in progress)

- Verify the owner's filesystem and browser/Electron backup, including linked media.
- Rehearse recovery into a separate directory and compare inventory and hashes.
- Establish account identity and per-request authorization; scope disk, browser
  databases, OPFS, preferences, assets, jobs, previews and caches appropriately.
- Route account/storage state through shared Rust transactions and expose typed
  Editor API capabilities, with explicit migration status and contract tests.
- Make legacy import explicit and bound to its destination account. New accounts
  start empty; account switching cannot import or display another account's data.
- Remove Git asset writes and serve private libraries through authorized storage.
- Support local-only operation, user-selected external storage, and multiple
  personal devices with authenticated pairing and conflict-preserving sync.
- Keep content and compute on clients. Cache speech models locally and run
  supported inference on WebGPU with an explicit compatible fallback.
- Provide usable account/storage/migration UI in the complete classic editor.
- Verify browser and Electron builds, isolation tests, migration tests, and an
  end-to-end internal testing flow. Report unsupported paths honestly.

## Migration contract

The complete classic editor remains the shipped product. The rewrite is not
feature-complete and must not replace it. Shared account policy and transactions
must have one Rust implementation consumed by the canonical Editor API and
classic WASM; platform filesystem, browser, identity and transport adapters may
live in their respective hosts. No feature removal is justified by this work.

This document records requirements, not a claim that the release gates pass.

## Current implementation checkpoint

The complete classic editor now has local account registration/sign-in, an
authenticated private disk namespace, scoped IndexedDB/OPFS/preferences, and a
copy-only legacy importer. Import receipts retain original hashes and final
activated-file hashes; missing linked files block activation. Cancellation and
interrupted imports preserve staging. Private library and project-font routes
replace public repository assets; uploads no longer stage Git changes.

Account storage policy is shared Rust (`account-core`) and exposed through the
Editor API registry and classic WASM. The portable snapshot contract validates
account ownership, hashes and paths before a host may restore files. Mounted
external drives, provider-synced folders, and personal-machine shares use an
encrypted, content-addressed vault. Immutable versions from different devices
remain separate. Password-protected recovery files transfer the account identity
and vault key to another host without replacing an existing account.

Opening a saved version verifies every object in staging, publishes the current
workspace as another encrypted version, and retains the previous local directory.
Restore journals retain paths and version IDs for interruption recovery. This is
explicit version selection; optional background snapshots publish changed work
every five minutes while the client is open. Automatic merge and direct peer
discovery are not implemented. Mounted shares are the current personal-machine
transport. Snapshot publication allows editor saves and rejects a source that
changes during the transfer. Interrupted activation recovers via its journal.

Classic MCP requests namespace browser sessions by authenticated account.
Command completions must match their originating session, and disconnecting one
session no longer cancels another session's work. Legacy unrestricted MCP clients
need the updated bridge binary. Version 2 descriptors are required by account
clients; older instances are ignored. Packaging includes the updated executable.

English voiceovers run in a browser worker using Kokoro, with cached model files,
WebGPU/CPU modes and cancellation. GPU and CPU generation, cancellation and import
into a synthetic project were exercised in the local browser preview. This does
not establish Hebrew support, offline operation before initial model download,
or inference inside the packaged Electron runtime. Its renderer and WebGPU adapter
were checked; the further GPU/offline test command was blocked by automatic
approval review. The voiceover feature is classic-only;
existing media commands import its output. No rewrite parity is claimed.

Hosted authentication, feedback/database and Redis integrations are optional for
local startup. Existing hosted integrations are retained when configured. The
current account host intentionally accepts only loopback requests; a standalone
remote browser deployment is not ready.

Verified so far: shared Rust account policy tests; Editor API account storage
registry/revision/undo tests; Rust MCP session ownership tests; browser storage
namespace tests; synthetic migration/recovery and cross-account disk tests;
HTTP authorization, account-pinned media ranges and empty second-account
libraries; opening a fresh editor project and persisting generated speech;
production Next builds and an unpacked Windows Electron build. Its bundled
standalone server passed a two-host identity transfer and encrypted restore with
byte-exact project comparison, served its static assets, and started without
hosted database/auth/Redis services. Version-switch tests recover both competing
versions, reject corruption, and preserve work after cancellation.

The complete pre-account backup was restored into a separate rehearsal directory:
all 2,763 manifest entries / 29,662,690,232 bytes matched their SHA-256 hashes. The
154 legacy library/font files also have a verified copy outside the checkout for
packaged-app discovery. The missing linked source remains an explicit exception.
Browser imports now archive original structured-clone records, OPFS bytes and
preferences before copying; same-ID projects retain separate editable variants.

The internal testing flow and outstanding owner migration/inference checks are
recorded in `INTERNAL-ACCOUNTS-TESTING.md`. Do not describe the owner's migration
as complete or migrate the originals in place.
