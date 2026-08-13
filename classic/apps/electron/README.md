# OpenCut Electron

This app packages the canonical `apps/web` interface inside Electron. It does
not contain a second editor implementation or a second state store.

## Development

From `classic/`:

```bash
bun install
bun run dev:electron
```

The command starts the regular Next.js development server and opens the same
URL in a sandboxed Electron renderer. Browser development at
`http://localhost:3000` continues to work at the same time.

The renderer adds an `OpenCutElectron/<version>` user-agent token. That token
selects the Electron performance profile during shared development without
forking the interface or requiring a second Next.js server.

## Package the application

```bash
# Unpacked application, useful for a fast packaging smoke test
bun run pack:electron

# Platform installer (NSIS on Windows, DMG/ZIP on macOS, AppImage on Linux)
bun run dist:electron
```

The build embeds the Next.js standalone server, `.next/static`, and `public`
assets under Electron's resources directory. At runtime that server listens on
`127.0.0.1:3000`; it is never exposed on a LAN interface. The renderer has
`nodeIntegration` disabled and runs with `contextIsolation` and Chromium's
sandbox enabled.

The bundled Electron executable launches the standalone Next.js entry in its
Node mode as a hidden child process. This keeps Next.js, filesystem storage,
and the generated WASM package on the same Node-compatible server path used by
the browser deployment; only the renderer host differs.

## Runtime optimization profile

The Electron build intentionally differs from the browser delivery path only
where the host makes a different tradeoff useful:

- Next.js skips HTTP compression because packaged traffic only crosses the
  loopback interface; this removes compression CPU work from the local server.
- Chromium prefers the high-performance GPU, keeps renderer work active when
  the window loses focus, eagerly populates the V8 code cache, disables the
  unused spellchecker and WebSQL, and receives a 512 MiB disk-cache budget.
- Compute workers may use up to eight threads when cross-origin isolation is
  available, while retaining one core for the interface. The browser path caps
  the same workload at four threads.

Use `OPENCUT_ELECTRON_GPU=balanced` to leave GPU selection to the operating
system. Override the cache size in bytes with
`OPENCUT_ELECTRON_DISK_CACHE_BYTES`. These settings affect only Electron; the
normal browser build keeps HTTP compression and Chromium's native background
throttling.

The web app's existing environment and service requirements still apply. Set
the same database, authentication, Redis, and third-party variables used by
`apps/web` before packaging. This shell intentionally changes the host, not
the product contract.

If the repository lives in a OneDrive-synchronized directory, Windows may lock
Electron's unpacked executable while packaging. In that case, build from a
non-synchronized checkout or set the builder output to a local temporary
directory.

Windows executable editing/signing is disabled by default so local builds do
not require Developer Mode or administrator privileges. Set
`OPENCUT_WINDOWS_SIGNING=true` in a properly configured release environment to
enable it.

## Migration status

This capability is **classic-only**: it is an Electron distribution of the
complete classic web product. It does not replace or remove the in-progress
GPUI desktop rewrite in `apps/desktop`.
