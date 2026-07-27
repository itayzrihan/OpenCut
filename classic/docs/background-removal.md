# Person background processing

PoCut can create a portrait alpha matte for a video clip and use it to remove,
blur, or desaturate the background. Inference runs locally in the browser; video
frames are not uploaded to a remote service.

## Model choice

The implementation uses [MODNet](https://github.com/ZHKKKe/MODNet) through the
Apache-2.0 [`Xenova/modnet`](https://huggingface.co/Xenova/modnet) ONNX conversion
and [Transformers.js](https://github.com/huggingface/transformers.js). This gives
PoCut a portrait-specific soft alpha matte, permissive licensing, a WebGPU path,
and a portable WASM fallback.

Alternatives considered:

- Robust Video Matting has strong temporal behavior, but its reference repository
  is GPL-3.0 and therefore was not embedded into PoCut.
- BRIA RMBG 2.0 is licensed for non-commercial use on its public model page, so it
  is not suitable as the default model for an application without a separate
  commercial agreement.
- MediaPipe Image Segmenter is portable and fast, but its person segmentation
  output is a semantic mask rather than a portrait-matting model optimized for
  fine hair and translucent boundaries.

## Architecture

The platform-neutral policy lives in `rust/crates/background-removal`. Rust owns:

- defaults, validation, and the Fast/Balanced/Precise quality profiles;
- alpha threshold, edge contrast, and temporal stabilization;
- safe placement of an optional duplicate clip.

The web app is a UI and platform adapter. A dedicated worker downloads and caches
the model, runs `background-removal`, and sends the alpha texture to the renderer.
WebGPU with FP32 weights is preferred; ONNX WASM with quantized weights is the
fallback. Requests are serialized to avoid multiplying GPU memory pressure, and
preview results use an LRU frame cache.

The compositor accepts a source-space mask for each layer. Sampling the mask with
the same transformed UV as the source keeps the matte aligned through crop,
scale, rotation, flips, and perspective transforms. Blur and grayscale render an
inverse-masked background layer before the foreground layer.

## Quality profiles

| Profile  | Model input | Preview sampling | Cached masks | Intended use                         |
| -------- | ----------: | ---------------: | -----------: | ------------------------------------ |
| Fast     |      256 px |           15 fps |           24 | Responsive editing on slower devices |
| Balanced |      384 px |           24 fps |           48 | Default quality/performance balance  |
| Precise  |      512 px |           30 fps |           72 | Fine hair and difficult boundaries   |

Export requests do not quantize time to the preview frame rate. The available
tuning controls are mask threshold, edge detail/contrast, edge feather, temporal
stability, and background blur strength.

## Duplicate placement safety

When **Duplicate to a video layer above** is selected, the original clip is left
unchanged and the processed copy has source audio disabled. Rust evaluates the
track immediately above the source:

1. It reuses that track only when it is a video track and no clip overlaps the
   duplicate's full time range.
2. Otherwise it inserts a new video track immediately above the source.

The duplicate is never inserted into a non-video track and never overwrites or
overlaps an existing clip on a reused track. The edit is an undoable timeline
command.

## Runtime notes

The first use requires downloading the model files; subsequent uses rely on the
browser cache. The properties panel reports download progress and the active
backend. If inference cannot initialize, rendering degrades to the original clip
and the panel shows the error instead of making the clip disappear.

MODNet is portrait-specific. Shots without a clearly visible person, extreme
motion blur, or heavy occlusion can still require threshold and edge tuning. For
the most difficult footage, use Precise quality and moderate temporal stability.
