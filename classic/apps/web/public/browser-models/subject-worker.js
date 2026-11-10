/* global self */
const root = new URL("./vision/", self.location.href);
let detectors;

async function createDetectors() {
	const { FilesetResolver, FaceDetector, PoseLandmarker } = await import(
		new URL("vision_bundle.mjs", root).href
	);
	const files = await FilesetResolver.forVisionTasks(new URL("wasm", root).href);
	const face = await FaceDetector.createFromOptions(files, {
		baseOptions: { modelAssetPath: new URL("blaze_face_short_range.tflite", root).href },
		runningMode: "IMAGE",
		minDetectionConfidence: 0.65,
	});
	const pose = await PoseLandmarker.createFromOptions(files, {
		baseOptions: { modelAssetPath: new URL("pose_landmarker_lite.task", root).href },
		runningMode: "IMAGE",
		numPoses: 2,
		minPoseDetectionConfidence: 0.6,
		minPosePresenceConfidence: 0.6,
	});
	return { face, pose };
}

self.onmessage = async ({ data: frames }) => {
	try {
		const { face, pose } = await (detectors ??= createDetectors());
		const detections = frames.map((frame) => {
			const { width, height } = frame;
			const faces = face.detect(frame).detections.flatMap(({ boundingBox, categories }) => {
				const confidence = categories[0]?.score;
				if (!boundingBox || !Number.isFinite(confidence)) return [];
				const x = Math.max(0, boundingBox.originX);
				const y = Math.max(0, boundingBox.originY);
				const right = Math.min(width, boundingBox.originX + boundingBox.width);
				const bottom = Math.min(height, boundingBox.originY + boundingBox.height);
				// The Rust contract uses an acceptance floor of 5. Retain the
				// confidence ordering after MediaPipe applies its stricter cutoff.
				return [{ x, y, width: right - x, height: bottom - y, score: confidence * 10 }];
			});
			const poses = pose.detect(frame).landmarks.map((landmarks) =>
				landmarks.map(({ x, y, visibility, presence }) => ({
					x, y, visibility,
					// The Web SDK may only report per-landmark visibility.
					presence: presence ?? visibility,
				})),
			);
			return { width, height, faces, poses };
		});
		self.postMessage({ available: true, data: { frames: detections } });
	} catch (error) {
		self.postMessage({ available: false, error: error instanceof Error ? error.message : String(error) });
	} finally {
		for (const frame of frames) frame.close();
	}
};
