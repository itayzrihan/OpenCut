export function getParallaxCameraWorldCenter({
	cameraWidth,
	cameraHeight,
	worldWidthFrames,
	worldHeightFrames,
	camera,
}: {
	cameraWidth: number;
	cameraHeight: number;
	worldWidthFrames: number;
	worldHeightFrames: number;
	camera: { x: number; y: number };
}): { x: number; y: number } {
	return {
		x: (cameraWidth * worldWidthFrames) / 2 + camera.x * cameraWidth,
		y: (cameraHeight * worldHeightFrames) / 2 + camera.y * cameraHeight,
	};
}

export function getParallaxWorldOriginOffset({
	cameraWidth,
	cameraHeight,
	worldWidthFrames,
	worldHeightFrames,
}: {
	cameraWidth: number;
	cameraHeight: number;
	worldWidthFrames: number;
	worldHeightFrames: number;
}): { x: number; y: number } {
	return {
		x: (cameraWidth * (Math.max(1, worldWidthFrames) - 1)) / 2,
		y: (cameraHeight * (Math.max(1, worldHeightFrames) - 1)) / 2,
	};
}

export function mapParallaxParentTimeToSourceTime({
	time,
	timeOffset,
	duration,
	sourceDuration,
}: {
	time: number;
	timeOffset: number;
	duration: number;
	sourceDuration: number;
}): number {
	return ((time - timeOffset) / Math.max(1, duration)) * sourceDuration;
}
