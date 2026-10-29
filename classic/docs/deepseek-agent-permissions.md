# Electron agent permissions

Implemented on `codex/deepseek-video-agent`, on top of the pinned DeepSeek Harness loop integration. Codex subscription sign-in and the existing provider transport remain unchanged.

The composer has a permission picker and, in Electron, an independent computer-access switch. Default: **Confirm destructive actions**, computer access **off**.

| Mode | Editor projects | Computer access enabled in Electron |
| --- | --- | --- |
| Plan | Inspect and propose a plan; no mutations | List folders and read UTF-8 files; no writes or shell |
| Confirm destructive actions | Reversible edits run; destructive capabilities pause for one-use approval | Read files; native confirmation for every file change and shell command |
| Full access | Execute available read/write/destructive capabilities | Read/change/delete files and execute commands without individual approvals |

Full access still follows OS permissions. No credential-management or policy-administration tools, or new generic machine endpoints, are added to the desktop MCP server. Arbitrary shell is deliberately treated as destructive: reliable classification of a shell program is not possible. Turning computer access on always shows a native dialog describing the selected mode. A request in chat cannot change the mode.

## Architecture and migration

- **Bridged:** serializable `EditorDocument.agentPolicy`, typed `agent.policy.set`, Rust agent enforcement and approval tickets. Read policy through `app.state.read` at `/agentPolicy`. Policy mutation is host/Admin only; model runs have at most Destructive access.
- **Classic Electron only:** typed `computer.files.inspect`, `computer.files.change`, `computer.terminal.execute` capabilities are installed with the desktop host bridge. The registry owns their schemas. External MCP discovery marks `computer.*` and `agent.policy.*` unavailable, and both the browser transport and native Classic bridge reject their invocation, including late-bound calls. The internal agent retains permission-controlled access. No separate MCP tool definitions or machine endpoints were added. Browser hosts cannot execute computer IO.
- **Platform IO:** Electron main owns files, child processes and native dialogs. IPC checks the owned main frame, origin, editor route and account/project. Grants are ephemeral, scoped to account/project/mode/generation and revoked on navigation, window loss and panel cleanup. Recovery turns the canonical computer flag off. Stop cancels pending confirmations before dispatch and terminates active process groups.
- **Project approvals:** pause before dispatch; host-only `approve` command authorizes exact arguments at the same revision and policy generation once. Changed arguments, revised projects and restored checkpoints cannot reuse approvals. `approve` is absent from the model schema. Undo/redo preserves the currently selected policy.
- **External effects:** explicitly nontransactional and outside editor Undo. Operation identities come from the Rust invocation context. Electron retains bounded in-memory receipts, preventing duplicate effects after a lost response in the same process. Transport/IO uncertainty remains pending for reconciliation instead of being reported as a definitive rejection. Restart loses native receipts and grants: do not automatically replay an unresolved operation after a restart.
- **Bounds:** file reads return UTF-8 chunks; text writes are bounded and use an expected hash (null means exclusive creation). Copy/move never overwrite; move uses link/unlink for files on one filesystem. Use the approved terminal for directory archives, extraction, cross-device moves and other general tasks. Terminal output and runtime are bounded. Binary preview/render output remains in the canonical ArtifactStore.

## Harness UI research

Reference: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), inspected at commit `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`.

The useful patterns were the composer-adjacent permission picker (`ui-permission-presets`), explicit full-access acknowledgement, plan review surface (`ui-user-questions`), and dedicated file/terminal cards (`ui-tool`). OpenCut now has a persistent scope/mode label, exact project-operation approval card, explicit plan-to-execution control, readable computer-operation cards and terminal output, alongside existing activity duration, stop/resume and plan step status.

Further UI improvements worth adding as separate work: a folder/workspace selector; full before/after file diffs in native approval; a searchable action history with filters; a persistent unresolved-operation recovery panel. These require additional contracts and are not represented as completed features here.

## Verification

`classic/scripts/verify-agent-computer.mjs` runs native permission and agent regressions, Electron IO/cancellation/replay tests, transport tests, the existing Harness/Codex connection tests, TypeScript and targeted product lint. The UI smoke test uses the actual Electron shell and a temporary local profile; no paid/live model request is needed. Existing unrelated lint errors in `commands.ts` and the repository architecture baseline are recorded separately from changed code.

The combined Earshot/Harness check is `node classic/scripts/verify-earshot-deepseek.mjs`. It uses the real canonical WASM runtime and Harness scheduler to discover Earshot, read its preset source and README, insert and customize procedural audio, and settle a bounded preview artifact. Provider responses and host PCM are fixtures; the scheduler, HTTP handler, contracts, transactions and artifact handling are real. Separate browser tests synthesize Earshot PCM and verify audio in an exported MP4. The check also covers external MCP discovery/invocation, permission denial, cancellation, Full Auto Edit and current Smart Takes behavior. This integration is bridged for Classic; it adds no second editor state store.
