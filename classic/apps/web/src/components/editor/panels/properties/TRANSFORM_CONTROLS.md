# Transform controls (bridged Classic UI)

Every numeric inspector field has a visible horizontal scrub handle, including
Position X/Y, Scale X/Y, Rotate and Perspective X/Y. Pointer capture supports
mouse, pen and touch without pointer lock. Motion is measured in CSS pixels;
one pixel uses the parameter's display step, Shift slows motion to one tenth,
and the existing parameter coercion applies bounds. Left/right keys also adjust
the focused handle. Typed values and expressions remain available.

The pointer gesture previews through the existing timeline preview pipeline and
commits once through the canonical editor transaction on release. Escape,
pointer cancellation and unmount discard an active inspector preview. Animation
channels follow the existing inspector keyframe policy.

Scale X + Y is a combined input that sets both existing axis values to the same
number, including on multiple selected clips. It is not an additional stored
transform or a persistent aspect-ratio lock. Separate X/Y controls remain.
Animated single-clip channels update at the playhead; bulk edits follow the
existing base-value policy. Scoped text uses the existing text-scope helpers.

No new project store or duplicate transform model is introduced. The persisted
values remain the validated Classic params/animation channels in EditorDocument,
readable through app.state.read and writable through the canonical registry.
The registry test in crates/editor-api/tests/classic_update.rs verifies combined
axis edits, preservation of timing/animation, and atomic Undo/Redo. The rewrite
UI has no separate implementation.
