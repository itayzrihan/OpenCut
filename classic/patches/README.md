# HyperFrames engine 0.8.115

`@hyperframes/engine@0.8.115` is pinned and patched through Bun's
`patchedDependencies`. The patch makes two host integration changes:

- `CaptureOptions.entryUrl` selects the exact original entry for navigation,
  WebGPU detection and verification pages. This preserves nested entry paths
  and relative requests without rewriting composition source.
- Chrome's render and GPU probe launches retain the browser sandbox. OpenCut
  runs imported scripts in a separate browser and on an isolated package origin.
  The capture adapter rejects a launch with sandbox or web security disabled.

Keep the patch when updating the lockfile. Before changing the engine version,
recheck its public capture contract, the patch and the real browser tests in
`apps/web/src/hyperframes/__tests__/capture-session.test.ts`. The original
HyperFrames package remains Apache-2.0 licensed; its notices ship with the
dependency.
