# rust/

Shared Rust crates that power OpenCut across platforms (web via WASM, desktop natively).

## Adding a new crate

1. Create it under `rust/crates/`
2. Add `bridge` as a dependency
3. Annotate public functions with `#[export]`

## How `#[export]` works

```rust
use bridge::export;

#[export]
pub fn round_to_frame(time: f64, fps: f64) -> f64 {
    (time * fps).round() / fps
}
```

Without the `wasm` feature, the macro is a no-op. With `--features wasm`, it expands to:

```rust
#[wasm_bindgen(js_name = "roundToFrame")]
pub fn round_to_frame(time: f64, fps: f64) -> f64 { ... }
```

Desktop uses the crates directly as Cargo dependencies.

## Testing

```bash
cargo test -p <crate>
```

### Track-scoped deletion (2026-10-11)

Status: **bridged**. Classic's “Delete to the same point” action invokes
`timeline.classic.remove` in `OpenCutRuntime` with `removal.samePoint: true`.
The canonical Rust transaction coalesces selected intervals per track and removes
only selected clips, shifting subsequent clips on those tracks by the removed
durations. Existing gaps remain; surviving clips are never trimmed. Unselected
tracks, scene bookmarks, media, clip-local automation and source offsets remain
unchanged. Selected caption tracks reconcile their own transcript only. Empty
tracks remain, locked selected tracks reject the entire operation, and the mode
cannot be combined with global `ripple`. UI global ripple/pruning reactors are
bypassed. Undo/Redo, revisions, dry runs and idempotency use the existing registry
contract and serialized Classic document; no additional UI state store or rewrite
implementation was introduced. Covered by `classic_remove` registry tests and a
real-WASM canonical command-manager integration test.
