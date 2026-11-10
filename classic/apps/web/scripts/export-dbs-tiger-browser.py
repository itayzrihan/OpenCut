"""Export the pinned DBS-TIGER model's spectral inference for ONNX Runtime Web."""

import argparse
import hashlib
import inspect
import json
from pathlib import Path
import runpy
import textwrap

import torch
from dbs.models import tiger

native = runpy.run_path(str(Path(__file__).with_name("dbs-tiger.py")))
weights = native["WEIGHTS"]


def exportable_pool(x, output_size):
    # Equivalent adaptive average pooling with a dynamic time axis.
    indices = torch.arange(output_size, device=x.device, dtype=torch.int64)
    width = x.shape[-1]
    first = indices * width // output_size
    last = ((indices + 1) * width + output_size - 1) // output_size
    prefix = torch.cat((torch.zeros_like(x[..., :1]), x.cumsum(-1)), dim=-1)
    return (prefix.index_select(-1, last) - prefix.index_select(-1, first)) / (last - first)


def replace_complex_ops():
    # Keep the pinned checkpoint's learned routing and separator. ONNX only
    # sees real-valued planes at the few boundaries where upstream uses complex.
    namespace = vars(tiger).copy()
    phase = textwrap.dedent(inspect.getsource(tiger.PhysicsChunker.physics_features))
    original = "torch.angle(torch.exp(1j * (phase[:, 1:] - phase[:, :-1])))"
    assert phase.count(original) == 1
    phase = phase.replace(
        original,
        "torch.atan2(torch.sin(phase[:, 1:] - phase[:, :-1]), "
        "torch.cos(phase[:, 1:] - phase[:, :-1]))",
    )
    exec(phase, namespace)
    tiger.PhysicsChunker.physics_features = namespace["physics_features"]

    dechunk = textwrap.dedent(inspect.getsource(tiger.FreqDechunker.forward))
    dechunk = dechunk[:dechunk.index("    spec_real, spec_imag =")] + """
    spec_real = spec_complex[:, 0].unsqueeze(2)
    spec_imag = spec_complex[:, 1].unsqueeze(2)
    real = spec_real * mask_real - spec_imag * mask_imag
    imag = spec_real * mask_imag + spec_imag * mask_real
    return torch.stack((real, imag), dim=1).permute(0, 1, 3, 2, 4)
"""
    exec(dechunk, namespace)
    tiger.FreqDechunker.forward = namespace["forward"]
    tiger.F.adaptive_avg_pool1d = exportable_pool


class SpectralModel(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, spectrum):
        model = self.model
        tokens, masks, states = [], [], []
        for (start, end), chunker in zip(model.band_slices, model.chunkers):
            values, confidence, boundaries, probs, mask, _ = chunker(
                spectrum[:, :, start:end], model.shared_router_backbone,
                model.shared_similarity_projection, 0,
            )
            tokens.append(values)
            masks.append(mask)
            states.append((confidence, boundaries, probs, mask, values.shape[1]))
        features = model.separator(torch.cat(tokens, dim=1), chunk_mask=torch.cat(masks, dim=1))
        parts = []
        offset = 0
        for (start, end), dechunker, state in zip(model.band_slices, model.dechunkers, states):
            confidence, boundaries, probs, mask, count = state
            parts.append(dechunker(
                features[:, offset:offset + count], boundaries, probs, confidence,
                mask, spectrum[:, :, start:end],
            ))
            offset += count
        return torch.cat(parts, dim=3)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    for name, digest in native["WEIGHT_HASHES"].items():
        if hashlib.sha256((weights / name).read_bytes()).hexdigest() != digest:
            raise RuntimeError(f"DBS-TIGER checksum mismatch for {name}")
    config = json.loads((weights / "config.json").read_text())
    if config["use_mixture_context"] or config["use_fla"]:
        raise RuntimeError("This export requires the pinned DBS-TIGER-DnR config")
    torch.set_num_threads(4)
    model = tiger.DBSTIGER.from_pretrained(str(weights)).eval()
    replace_complex_ops()
    # Non-zero bins exercise the hard boundary and segment pooling paths.
    example = torch.rand((1, 2, 1025, 517), generator=torch.Generator().manual_seed(101))
    with torch.inference_mode():
        torch.onnx.export(
            SpectralModel(model).eval(), example, str(args.output), opset_version=18,
            input_names=["spectrum"], output_names=["stems"],
            dynamic_axes={"spectrum": {3: "time"}, "stems": {4: "time"}},
        )
