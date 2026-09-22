"""Run once from any directory: python classic/scripts/local-subject-framing/setup.py"""
from pathlib import Path
import os, subprocess, sys, venv, hashlib, urllib.request
root=Path(__file__).resolve().parents[2]
runtime=root/".local"/"subject-framing"
venv.EnvBuilder(with_pip=True).create(runtime)
python=runtime/("Scripts/python.exe" if os.name=="nt" else "bin/python")
subprocess.run([str(python),"-m","pip","uninstall","-y","opencv-python-headless"],check=True)
subprocess.run([str(python),"-m","pip","install","-r",str(Path(__file__).with_name("requirements.txt"))],check=True)
model=runtime/"models"/"pose_landmarker_lite.task"
digest="59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a"
if not model.exists() or hashlib.sha256(model.read_bytes()).hexdigest()!=digest:
    model.parent.mkdir(parents=True,exist_ok=True)
    data=urllib.request.urlopen("https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",timeout=60).read()
    if hashlib.sha256(data).hexdigest()!=digest:
        raise RuntimeError("Pose model checksum mismatch")
    model.write_bytes(data)
print("Local subject detector ready:",python)
