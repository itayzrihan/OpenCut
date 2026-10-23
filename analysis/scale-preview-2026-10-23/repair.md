# Scale inspector selection visibility

The live Yarden scene had the disabled C7446 alternative selected on `Routed 1 - איתי`, with saved scale X/Y 5.34. The preview at 8.633 seconds showed the enabled C7454 clip on Main Track at scale 1. These are different elements. The renderer correctly omits the disabled alternative.

Clicking the visible subject selected the Main Track element. Changing combined scale from 1 to 1.4 visibly enlarged the paused video without seeking or playing. Undo restored scale 1. Canonical scene comparison before/after this probe differed only in `updatedAt`; the user's existing disabled-angle scale was preserved.

The inspector now identifies the selected element and track. Disabled video/image clips and hidden tracks display a persistent status message explaining that edits are saved but do not appear in the preview, with guidance to select the visible video directly. Selection helper typing preserves the actual track metadata. No automatic camera activation, transform redirection, media changes, or new state store was added.

Migration status: Classic UI only; transform edits continue through the existing canonical preview/commit and capability registry. The rewrite has no duplicate implementation.

Validation uses the existing transform-rendering, preview overlay, inspector playhead, bulk-selection and canonical update/Undo/Redo suites (15 tests), production TypeScript, a full immutable production build, live deployed UI inspection, and comparison of all 12 scene contents/settings against the saved baseline. `verification.json` records deployed evidence; screenshots show the scale probe and final inspector. No video export is part of this UI repair.
