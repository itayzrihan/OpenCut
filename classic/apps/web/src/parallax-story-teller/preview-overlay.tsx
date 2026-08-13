import type { TCanvasSize } from "@/project/types";
import type { TScene } from "@/timeline";
import type { PreviewOverlaySourceResult } from "@/preview/overlays";
import type { MediaTime } from "@/wasm";
import { resolveOverlayMovementCameraState } from "@/effects/overlay-movement-presets";
import { findParallaxCameraGuideElement } from "@/parallax-story-teller/model";
import { getParallaxCameraWorldCenter } from "@/parallax-story-teller/camera-geometry";

export function getParallaxCanvasPreviewOverlaySource({
	scene,
	canvasSize,
	currentTime,
	duration,
	cameraOverride,
}: {
	scene: TScene | null;
	canvasSize: TCanvasSize | undefined;
	currentTime: MediaTime;
	duration: MediaTime;
	cameraOverride?: { x: number; y: number; scale: number } | null;
}): PreviewOverlaySourceResult {
	if (!scene?.parallax || !canvasSize) {
		return { definitions: [], instances: [] };
	}
	const metadata = scene.parallax;
	const cameraGuide = findParallaxCameraGuideElement({ scene });
	return {
		definitions: [],
		instances: [
			{
				id: `parallax-camera-frame:${scene.id}`,
				mount: { kind: "scene" },
				plane: "under-interaction",
				pointerEvents: "none",
				zIndex: 4,
				render: ({ sceneWidth, sceneHeight }) => (
					<ParallaxCameraFrames
						sceneWidth={sceneWidth}
						sceneHeight={sceneHeight}
						worldWidthFrames={metadata.worldWidthFrames}
						worldHeightFrames={metadata.worldHeightFrames ?? 1}
						direction={metadata.direction}
						progress={duration > 0 ? currentTime / duration : 0}
						camera={
							cameraOverride ??
							(cameraGuide && typeof cameraGuide.params.specJson === "string"
								? resolveOverlayMovementCameraState({
										effectParams: cameraGuide.params,
										animations: cameraGuide.animations,
										localTime: currentTime,
										duration,
									})
								: undefined)
						}
					/>
				),
			},
		],
	};
}

function ParallaxCameraFrames({
	sceneWidth,
	sceneHeight,
	worldWidthFrames,
	worldHeightFrames,
	direction,
	progress,
	camera,
}: {
	sceneWidth: number;
	sceneHeight: number;
	worldWidthFrames: number;
	worldHeightFrames: number;
	direction: "left" | "right";
	progress: number;
	camera?: { x: number; y: number; scale: number };
}) {
	const frameWidth = sceneWidth / worldWidthFrames;
	const frameHeight = sceneHeight / worldHeightFrames;
	const clampedProgress = Math.max(0, Math.min(1, progress));
	const cameraScale = Math.max(0.05, camera?.scale ?? 1);
	const visibleFrameWidth = frameWidth / cameraScale;
	const visibleFrameHeight = frameHeight / cameraScale;
	const centerX = sceneWidth / 2;
	const centerY = sceneHeight / 2;
	const directionFactor = direction === "right" ? 1 : -1;
	const startLeft = centerX - visibleFrameWidth / 2;
	const endLeft = startLeft + directionFactor * frameWidth;
	const cameraCenter = camera
		? getParallaxCameraWorldCenter({
				cameraWidth: frameWidth,
				cameraHeight: frameHeight,
				worldWidthFrames,
				worldHeightFrames,
				camera,
			})
		: null;
	const currentLeft = cameraCenter
		? cameraCenter.x - visibleFrameWidth / 2
		: startLeft + directionFactor * frameWidth * clampedProgress;
	const startTop = centerY - visibleFrameHeight / 2;
	const currentTop = cameraCenter
		? cameraCenter.y - visibleFrameHeight / 2
		: startTop;
	return (
		<div className="absolute inset-0 overflow-hidden bg-[radial-gradient(circle_at_center,transparent_0%,rgba(0,0,0,0.1)_100%)]">
			<CameraFrame
				left={startLeft}
				top={startTop}
				width={visibleFrameWidth}
				height={visibleFrameHeight}
				label="START"
				muted
			/>
			<CameraFrame
				left={endLeft}
				top={startTop}
				width={visibleFrameWidth}
				height={visibleFrameHeight}
				label="END"
				muted
			/>
			<CameraFrame
				left={currentLeft}
				top={currentTop}
				width={visibleFrameWidth}
				height={visibleFrameHeight}
				label="CAMERA"
			/>
			<div className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/60 px-3 py-1 text-[10px] font-medium tracking-wide text-white/75 backdrop-blur">
				WORLD CANVAS · place layers anywhere · camera moves {direction}
			</div>
		</div>
	);
}

function CameraFrame({
	left,
	top,
	width,
	height,
	label,
	muted = false,
}: {
	left: number;
	top: number;
	width: number;
	height: number;
	label: string;
	muted?: boolean;
}) {
	return (
		<div
			className={`absolute border-2 ${muted ? "border-dashed border-white/25" : "border-cyan-300 shadow-[0_0_0_9999px_rgba(0,0,0,0.12),0_0_24px_rgba(103,232,249,0.24)]"}`}
			style={{ left, top, width, height }}
		>
			<div
				className={`absolute top-2 left-2 rounded px-1.5 py-0.5 text-[9px] font-semibold ${muted ? "bg-white/10 text-white/55" : "bg-cyan-300 text-slate-950"}`}
			>
				{label}
			</div>
		</div>
	);
}
