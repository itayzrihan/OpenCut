# Local Production launcher (macOS)

Open **OpenCut Local.app** on the Desktop. It opens a Hebrew control panel at
`http://127.0.0.1:3210` with buttons to start/stop Production, open the browser
editor, open Electron, update from the local working tree, and close the panel.
The editor runs at `http://localhost:3211` and binds only to loopback.

The browser and Electron use the same production server and existing accounts
under `~/Movies/OpenCut Accounts`. Electron has its own browser profile, so its
first launch may require signing into the existing account. Neither launcher
installation nor deployment imports, copies, or deletes project data.

## Daily use

1. Double-click the Desktop app and choose **הפעל Production**.
2. Choose **פתח בדפדפן** or **פתח ב־Electron**. Either also starts the server if
   it is stopped. Electron uses the existing canonical Classic shell.
3. Finish editing and wait for saves before **כבה Production**. This also closes
   the launcher-owned Electron and MCP processes. Development servers or MCP
   instances started independently are not terminated.
4. **סגור את מסך הניהול** exits the controller when Production is stopped.
   If all panel tabs are closed while Production is stopped, the controller
   exits after two minutes. There is no login item, launch daemon, or automatic
   production startup. Leaving the editor running requires explicit Stop.

## Updating

Stop Production, then choose **בנה ועדכן Production**. The builder reads the
current local working tree, including uncommitted product changes. Finish source
edits before building; it checks product-source fingerprints before and after
the build and refuses activation if the source changed in between.

The build compiles canonical Rust/WASM and the local MCP binary, builds optimized
Next with webpack into `.next-local-production`, and packages a separate
standalone release, assets, Electron shell/dependencies and Electron executable.
The subject-framing script is frozen in the release; its already-installed local
Python/model environment is reused. Next's `.next` development output is not
replaced. Development edits do not change the running release.

After an HTTP startup smoke check, `current.json` is replaced atomically. Failed
builds preserve the current release, and `previous.json` records the prior one.
Old releases are retained; they can be removed manually when no longer needed.
The update button never pulls Git, merges branches, or updates dependencies.

## Files and recovery

Everything generated lives outside Git under
`~/Library/Application Support/OpenCut Local/`:

- `config.json`: Node/Bun paths, tool PATH, ports, and existing account root.
- `runtime.env`: private copy of the original local environment, created once
  on installation with mode 0600. Update this file if local integration settings
  change. Production forces `NODE_ENV=production`, its own site URL and loopback
  access; development/public proxy settings cannot expose the local controller.
- `releases/<timestamp>-<commit>/`: independent production build and shell.
- `current.json`, `previous.json`: release pointers, source hash and build date.
- `electron-profile/`: separate Production Electron cookies/cache/preferences.
- `logs/`: build, launcher, production, Electron and control-plane diagnostics.

To reinstall the Desktop shortcut without changing existing configuration:

```sh
node classic/scripts/local-production/install.mjs
```

To build from a terminal:

```sh
node classic/scripts/local-production/build.mjs
```

The launcher requires this checkout to remain at its installed location and
Node/Bun/Rust build tools to remain available. Re-run the installer/update the
configuration if these move. The deployed editor and Electron assets are copied
into their release directory. This is a local macOS installation, not a signed
redistributable DMG or a remotely hosted service.

## Architecture and verification

Migration status is **Classic-only host packaging**. This controller manages
processes and files; it has no editor state, document mutations, or parallel
capability registry. Browser and Electron continue through `OpenCutRuntime`.
The control API binds to 127.0.0.1, validates Host/Origin, requires an unguessable
per-run token for status/actions, rejects framing, and exposes fixed actions
only. It cannot accept arbitrary commands, paths or URLs from HTTP callers.

Run the lifecycle/security test and existing Electron runtime tests with:

```sh
node --test classic/scripts/local-production/server.test.mjs
bun test classic/apps/electron/test/runtime.test.js
```

The lifecycle test checks unauthorized and cross-origin rejection, DNS-rebinding
Host rejection, unknown actions, idempotent Start, update/quit rejection while
running, complete Stop and controller exit. Each build additionally verifies
that the actual standalone production server starts and responds successfully.

Verified on 2026-10-09: an optimized standalone build and an update initiated by
the panel both completed; opening the installed Desktop app started the panel;
Start/Open Browser displayed the existing account and its Smart Takes / Full
Auto project; Electron opened the production `/projects` sign-in screen in its
separate profile; Stop closed the owned server, Electron and MCP processes.
The final Stop displayed no error. The lifecycle test and seven existing
Electron runtime tests passed. A cancelled build retained the previous pointer.
The old development editor can still hold a real project lease: close that
editor or explicitly take ownership when moving the same project to Production.
