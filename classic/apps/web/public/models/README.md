# Background-removal model

OpenCut vendors the `Xenova/modnet` model so Speaker Frame Breakout can run
with remote model loading disabled. The model source and license are published
at <https://huggingface.co/Xenova/modnet>.

The ONNX binaries are tracked with Git LFS. After cloning, run `git lfs pull`
and then `bun run assets:verify` from `classic/apps/web` to confirm every
vendored model and runtime asset.
