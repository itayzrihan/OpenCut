"use client";

import { Button } from "@/components/ui/button";
import { useEditor, useEditorTimelineScenes } from "@/editor/use-editor";
import {
	ArrowLeft,
	Camera,
	Expand,
	Layers3,
	Maximize2,
	MousePointer2,
	RotateCcw,
	Sparkles,
	X,
} from "lucide-react";
import { ZERO_MEDIA_TIME } from "@/wasm";
import {
	findParallaxCameraGuideElement,
	getCameraAnimationsBeforeCameraMan,
	PARALLAX_CAMERA_MAN_BACKUP_PARAM,
} from "./model";
import { resolveOverlayMovementCameraState } from "@/effects/overlay-movement-presets";
import { useCameraManStore } from "./camera-man-store";
import {
	cameraManSamplesToAnimations,
	easeCameraManSamples,
	spreadCameraManSamples,
} from "./camera-man";
import { toast } from "sonner";
import { getDisplayTracks } from "@/timeline";

export function ParallaxCanvasEditorBanner() {
	const editor = useEditor();
	const scene = useEditorTimelineScenes((value) =>
		value.scenes.getActiveSceneOrNull(),
	);
	const cameraMan = useCameraManStore();
	if (!scene?.parallax) return null;

	const handleExit = async () => {
		const { parentSceneId, parentElementId } = scene.parallax!;
		if (cameraMan.sceneId === scene.id) {
			editor.playback.pause();
			useCameraManStore.getState().reset();
		}
		await editor.scenes.switchToScene({ sceneId: parentSceneId });
		editor.playback.seek({ time: ZERO_MEDIA_TIME });
		const parentScene = editor.scenes.getActiveSceneOrNull();
		const parentTrack = parentScene?.tracks.overlay.find((track) =>
			track.elements.some((element) => element.id === parentElementId),
		);
		if (parentTrack && parentElementId) {
			editor.selection.setSelectedElements({
				elements: [{ trackId: parentTrack.id, elementId: parentElementId }],
			});
		}
	};
	const handleWorldSize = ({
		width,
		height,
	}: {
		width?: number;
		height?: number;
	}) => {
		if (!scene.parallax) return;
		const updatedScene = {
			...scene,
			parallax: {
				...scene.parallax,
				worldWidthFrames: Math.max(
					1,
					Math.round(width ?? scene.parallax.worldWidthFrames),
				),
				worldHeightFrames: Math.max(
					1,
					Math.round(height ?? scene.parallax.worldHeightFrames ?? 1),
				),
			},
			updatedAt: new Date(),
		};
		editor.scenes.setScenes({
			scenes: editor.scenes
				.getScenes()
				.map((candidate) =>
					candidate.id === updatedScene.id ? updatedScene : candidate,
				),
			activeSceneId: updatedScene.id,
		});
	};
	const handleAddParallaxTrack = () => {
		const displayTracks = getDisplayTracks({ tracks: scene.tracks });
		const guide = findParallaxCameraGuideElement({ scene });
		const fixedTrackIndexes = displayTracks.flatMap((track, index) =>
			track.id === scene.tracks.main.id ||
			track.elements.some((element) => element.id === guide?.id)
				? [index]
				: [],
		);
		const insertIndex = Math.max(-1, ...fixedTrackIndexes) + 1;
		const trackId = editor.timeline.addTrack({
			type: "parallax",
			index: insertIndex,
		});
		const added = editor.scenes
			.getActiveScene()
			.tracks.overlay.some((track) => track.id === trackId);
		if (!added) {
			toast.error("Parallax track could not be added");
			return;
		}
		toast.success("Parallax track added below the Camera and Main layers");
	};
	const handleCameraMan = () => {
		if (cameraMan.phase === "recording" && cameraMan.sceneId === scene.id) {
			if (cameraMan.current) {
				useCameraManStore.getState().record({
					time: editor.playback.getCurrentTime(),
					...cameraMan.current,
				});
			}
			editor.playback.pause();
			useCameraManStore.getState().stop();
			return;
		}
		const guide = findParallaxCameraGuideElement({ scene });
		if (!guide) {
			toast.error("Camera layer is missing");
			return;
		}
		const time = editor.playback.getCurrentTime();
		const camera = resolveOverlayMovementCameraState({
			effectParams: guide.params,
			animations: guide.animations,
			localTime: time,
			duration: guide.duration,
		});
		useCameraManStore.getState().start({
			sceneId: scene.id,
			sample: { time, ...camera },
		});
		editor.playback.play();
	};
	const commitCameraMan = (mode: "ease" | "spread") => {
		const guide = findParallaxCameraGuideElement({ scene });
		const track = scene.tracks.overlay.find((candidate) =>
			candidate.elements.some((element) => element.id === guide?.id),
		);
		if (!guide || !track || cameraMan.samples.length === 0) return;
		const samples =
			mode === "ease"
				? easeCameraManSamples({ samples: cameraMan.samples })
				: spreadCameraManSamples({
						samples: cameraMan.samples,
						duration: guide.duration,
					});
		editor.timeline.updateElements({
			updates: [
				{
					trackId: track.id,
					elementId: guide.id,
					patch: {
						params: {
							...guide.params,
							[PARALLAX_CAMERA_MAN_BACKUP_PARAM]:
								typeof guide.params[PARALLAX_CAMERA_MAN_BACKUP_PARAM] ===
									"string" &&
								guide.params[PARALLAX_CAMERA_MAN_BACKUP_PARAM] !== ""
									? guide.params[PARALLAX_CAMERA_MAN_BACKUP_PARAM]
									: JSON.stringify(guide.animations ?? {}),
						},
						animations: cameraManSamplesToAnimations({
							samples,
							baseAnimations: guide.animations,
						}),
					},
				},
			],
		});
		useCameraManStore.getState().reset();
		toast.success(
			mode === "ease"
				? `Camera move eased to ${samples.length} keyframes`
				: "Camera move spread evenly across the scene",
		);
	};
	const cancelCameraMan = () => {
		editor.playback.pause();
		useCameraManStore.getState().reset();
		toast.success("Camera Man recording discarded");
	};
	const restoreCameraBeforeCameraMan = () => {
		const guide = findParallaxCameraGuideElement({ scene });
		const track = scene.tracks.overlay.find((candidate) =>
			candidate.elements.some((element) => element.id === guide?.id),
		);
		if (!guide || !track) {
			toast.error("Camera layer is missing");
			return;
		}
		editor.playback.pause();
		useCameraManStore.getState().reset();
		editor.timeline.updateElements({
			updates: [
				{
					trackId: track.id,
					elementId: guide.id,
					patch: {
						params: {
							...guide.params,
							[PARALLAX_CAMERA_MAN_BACKUP_PARAM]: "",
						},
						animations: getCameraAnimationsBeforeCameraMan({
							params: guide.params,
							duration: guide.duration,
							currentAnimations: guide.animations,
						}),
					},
				},
			],
		});
		toast.success("Camera restored. This action can also be undone.");
	};

	return (
		<div className="mx-3 mb-1 flex h-10 shrink-0 items-center gap-3 rounded-md border border-cyan-400/25 bg-cyan-400/8 px-2.5 text-xs">
			<Button
				size="sm"
				variant="secondary"
				className="h-7 gap-1.5"
				onClick={() => void handleExit()}
			>
				<ArrowLeft className="size-3.5" />
				Back to story
			</Button>
			<div className="flex min-w-0 items-center gap-1.5 font-medium text-cyan-100">
				<Camera className="size-3.5" />
				<span className="truncate">Editing {scene.name}</span>
			</div>
			<Button
				size="sm"
				variant="ghost"
				className="h-7 gap-1.5 text-muted-foreground"
				onClick={() =>
					handleWorldSize({ width: scene.parallax!.worldWidthFrames + 1 })
				}
			>
				<Expand className="size-3.5" />
				Expand world · {scene.parallax.worldWidthFrames} frames
			</Button>
			<input
				aria-label="World width in camera frames"
				title="World width in camera frames"
				type="number"
				min="1"
				className="h-7 w-12 rounded border bg-background px-1 text-center tabular-nums"
				value={scene.parallax.worldWidthFrames}
				onChange={(event) =>
					handleWorldSize({ width: Number(event.target.value) })
				}
			/>
			<input
				aria-label="World height in camera frames"
				title="World height in camera frames"
				type="number"
				min="1"
				className="h-7 w-12 rounded border bg-background px-1 text-center tabular-nums"
				value={scene.parallax.worldHeightFrames ?? 1}
				onChange={(event) =>
					handleWorldSize({ height: Number(event.target.value) })
				}
			/>
			<Button
				size="sm"
				variant="ghost"
				className="h-7 gap-1.5"
				onClick={handleAddParallaxTrack}
			>
				<Layers3 className="size-3.5" />
				Add Parallax
			</Button>
			<Button
				size="sm"
				variant={cameraMan.phase === "recording" ? "destructive" : "ghost"}
				className="h-7 gap-1.5"
				onClick={handleCameraMan}
			>
				<Camera className="size-3.5" />
				{cameraMan.phase === "recording" ? "Stop" : "Camera Man"}
			</Button>
			{cameraMan.phase === "review" && cameraMan.sceneId === scene.id && (
				<>
					<Button
						size="sm"
						variant="ghost"
						className="h-7 gap-1"
						onClick={() => commitCameraMan("ease")}
					>
						<Sparkles className="size-3.5" /> Ease Keyframes
					</Button>
					<Button
						size="sm"
						variant="ghost"
						className="h-7 gap-1"
						onClick={() => commitCameraMan("spread")}
					>
						<Maximize2 className="size-3.5" /> Spread all over
					</Button>
					<Button
						size="sm"
						variant="ghost"
						className="h-7 gap-1"
						onClick={cancelCameraMan}
					>
						<X className="size-3.5" /> Cancel
					</Button>
				</>
			)}
			<Button
				size="sm"
				variant="ghost"
				className="h-7 gap-1 text-amber-200"
				onClick={restoreCameraBeforeCameraMan}
				title="Restore the camera state from before Camera Man, or the template route for older recordings"
			>
				<RotateCcw className="size-3.5" /> Undo Camera Man
			</Button>
			<div className="ml-auto hidden items-center gap-1.5 text-muted-foreground xl:flex">
				<MousePointer2 className="size-3.5" />
				Add text, images and video to this timeline — their position is pinned
				to the world
			</div>
		</div>
	);
}
