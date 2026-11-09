"""Install and run the pinned local DBS-TIGER soundtrack separator."""

import argparse
import hashlib
import os
from pathlib import Path
import struct
import subprocess
import sys
from urllib.request import urlopen
import venv


MODEL_REVISION = "22da7d4cd3ea63f9365181008bff1c0d2ab6fb2b"
SOURCE_REVISION = "ff526463a58ee0278e7bd05c4b8bce112b743e34"
WEIGHT_HASHES = {
    "config.json": "c7f7893323e78f9b99747a13090558a13c4f4b77383a38acb9979709fd04d1d8",
    "model.safetensors": "3d8205743f2a6f5a6704f5d4104d7cf5bf7bf02dab2fd728da31f4c69225cadb",
}
RUNTIME = Path(
    os.environ.get("OPENCUT_DBS_TIGER_HOME") or Path.home() / ".opencut/models/dbs-tiger"
)
WEIGHTS = RUNTIME / MODEL_REVISION
READY = WEIGHTS / "ready"
SAMPLE_RATE = 48_000


def install():
    if not (3, 11) <= sys.version_info[:2] <= (3, 12):
        raise RuntimeError("Run setup with Python 3.11 or 3.12")
    READY.unlink(missing_ok=True)
    environment = RUNTIME / "venv"
    venv.EnvBuilder(with_pip=True).create(environment)
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    pip = [str(python), "-m", "pip", "install", "--disable-pip-version-check", "--no-input"]
    subprocess.run(
        [*pip, "--index-url", "https://download.pytorch.org/whl/cpu", "torch==2.5.1"],
        check=True,
    )
    source = f"https://codeload.github.com/JusperLee/Dynamic-Band-Splitting/zip/{SOURCE_REVISION}"
    digest = "d5c94d606dfcd1aec0de0b79f10d6d35705fcef78e60476cc25e8c9577e49f0b"
    subprocess.run(
        [*pip, f"dbs @ {source}#sha256={digest}", "scipy==1.15.3", "einops==0.8.1",
         "rotary-embedding-torch==0.8.9"],
        check=True,
    )
    WEIGHTS.mkdir(parents=True, exist_ok=True)
    for name, digest in WEIGHT_HASHES.items():
        path = WEIGHTS / name
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == digest:
            continue
        url = f"https://huggingface.co/JusperLee/DBS-TIGER-DnR/resolve/{MODEL_REVISION}/{name}"
        with urlopen(url, timeout=60) as response:
            data = response.read(5_000_000)
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError(f"DBS-TIGER checksum mismatch for {name}")
        path.write_bytes(data)
    subprocess.run(
        [str(python), "-c", "import scipy.signal; from dbs.engine import separate; from dbs.models import DBSTIGER"],
        check=True,
    )
    READY.touch()
    print(f"DBS-TIGER is ready at {RUNTIME}")


def separate_audio(directory, frames, leading_frames):
    import numpy as np
    import torch
    from dbs.engine import separate
    from dbs.models import DBSTIGER
    from scipy.signal import resample_poly

    mix = np.fromfile(directory / "input.f32", dtype="<f4").reshape(-1, 2)
    mix = mix[:frames - leading_frames]
    mix[~np.isfinite(mix)] = 0
    estimates = np.zeros((3, frames, 2), dtype=np.float32)
    if np.any(mix):
        # The official model is mono. Keep distinct left/right channels rather
        # than collapsing the original stereo background to the center.
        same_channels = np.array_equal(mix[:, 0], mix[:, 1])
        mono_inputs = mix[:, :1] if same_channels else mix
        model_input = resample_poly(mono_inputs.T, 147, 160, axis=-1)
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        model = DBSTIGER.from_pretrained(str(WEIGHTS)).eval().cpu()
        with torch.inference_mode():
            stems = separate(
                model,
                torch.from_numpy(model_input[:, None, :]),
                {"mode": "chunked", "chunk_seconds": 6.0, "hop_seconds": 3.0},
                sample_rate=44_100,
            ).numpy()
        stems = resample_poly(stems, 160, 147, axis=-1)[..., :len(mix)].transpose(1, 2, 0)
        if not np.isfinite(stems).all():
            raise RuntimeError("DBS-TIGER returned non-finite audio")
        estimates[:, leading_frames:leading_frames + len(mix)] = stems

    music, effects, dialogue = estimates
    outputs = {"background": music + effects, "dialogue": dialogue, "music": music, "effects": effects}
    for name, samples in outputs.items():
        # The timeline consumes stereo IEEE float WAV with a 44-byte header.
        data = samples.astype("<f4", copy=False).tobytes()
        header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(data),
                             b"WAVE", b"fmt ", 16, 3, 2, SAMPLE_RATE,
                             SAMPLE_RATE * 8, 8, 32, b"data", len(data))
        (directory / f"{name}.wav").write_bytes(header + data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    modes = parser.add_subparsers(dest="mode", required=True)
    modes.add_parser("setup")
    infer = modes.add_parser("separate")
    infer.add_argument("directory", type=Path)
    infer.add_argument("frames", type=int)
    infer.add_argument("leading_frames", type=int)
    args = parser.parse_args()
    if args.mode == "setup":
        install()
    else:
        separate_audio(args.directory, args.frames, args.leading_frames)
