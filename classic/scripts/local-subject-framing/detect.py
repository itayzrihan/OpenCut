"""Local inference only. Rust owns acceptance, association and crop policy."""
import json
import sys
import base64
from pathlib import Path
import cv2
import numpy as np
import mediapipe as mp

cv2.setNumThreads(2)
request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
assert 3 <= len(request["frames"]) <= 5
face = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
model = Path(__file__).resolve().parents[2] / ".local/subject-framing/models/pose_landmarker_lite.task"
options = mp.tasks.vision.PoseLandmarkerOptions(
    base_options=mp.tasks.BaseOptions(model_asset_path=str(model), delegate=mp.tasks.BaseOptions.Delegate.CPU),
    running_mode=mp.tasks.vision.RunningMode.IMAGE,
    num_poses=2, min_pose_detection_confidence=0.6, min_pose_presence_confidence=0.6)
frames = []
with mp.tasks.vision.PoseLandmarker.create_from_options(options) as detector:
    for encoded in request["frames"]:
        raw = base64.b64decode(encoded, validate=True)
        assert len(raw) <= 200000
        image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        assert image is not None and image.shape[0] <= 1920 and image.shape[1] <= 1920
        height, width = image.shape[:2]
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        boxes, _, weights = face.detectMultiScale3(gray, scaleFactor=1.05, minNeighbors=6, minSize=(28, 28), outputRejectLevels=True)
        result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(image, cv2.COLOR_BGR2RGB)))
        poses = [[{"x":p.x,"y":p.y,"visibility":p.visibility,"presence":p.presence} for p in pose] for pose in result.pose_landmarks]
        faces = [{"x":int(x),"y":int(y),"width":int(w),"height":int(h),"score":float(score)} for (x,y,w,h),score in zip(boxes,weights)]
        frames.append({"width":width,"height":height,"faces":faces,"poses":poses})
Path(sys.argv[2]).write_text(json.dumps({"frames":frames,"detector":"opencv-4.12-mediapipe-pose-lite-local-cpu"}), encoding="utf-8")
