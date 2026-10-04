"use client";
import { useCallback, useMemo } from "react";
import {
	useEditorPlayback,
	useEditorProject,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import { PreviewPanel } from "@/preview/components";
import {
	createPreviewOverlayControl,
	isPreviewOverlayVisible,
	mergePreviewOverlaySources,
} from "@/preview/overlays";
import { usePreviewStore } from "@/preview/preview-store";
import {
	getSafeAreaPreviewOverlaySource,
	safeAreaPreviewOverlay,
} from "@/preview/safe-area-overlay";
import { getGuidePreviewOverlaySource } from "@/guides";
import {
	bookmarkNotesPreviewOverlay,
	useBookmarkPreviewOverlaySource,
} from "@/timeline/bookmarks/preview-overlay-source";
import { getParallaxCanvasPreviewOverlaySource } from "@/parallax-story-teller/preview-overlay";
import { useCameraManStore } from "@/parallax-story-teller/camera-man-store";
import { ZERO_MEDIA_TIME } from "@/wasm";
import type { EditorCore } from "@/core";
import type { Bookmark } from "@/timeline/types";

const EMPTY_BOOKMARKS: Bookmark[] = [];

export function PreviewPanelWithOverlays() {
	const [activeScene, sceneDuration] = useEditorTimelineScenes((editor) => [
		editor.scenes.getActiveSceneOrNull(),
		editor.timeline.getTotalDuration(),
	]);
	const project = useEditorProject((editor) => editor.project.getActive());
	const cameraManPhase = useCameraManStore((state) => state.phase);
	const cameraManSceneId = useCameraManStore((state) => state.sceneId);
	const cameraManCurrent = useCameraManStore((state) => state.current);
	const activeGuide = usePreviewStore((state) => state.activeGuide);
	const overlays = usePreviewStore((state) => state.overlays);
	const setOverlayVisibility = usePreviewStore(
		(state) => state.setOverlayVisibility,
	);
	const showBookmarkNotes = isPreviewOverlayVisible({
		overlay: bookmarkNotesPreviewOverlay,
		overlays,
	});
	const showSafeArea = isPreviewOverlayVisible({
		overlay: safeAreaPreviewOverlay,
		overlays,
	});
	const bookmarkSource = useBookmarkPreviewOverlaySource({
		bookmarks: activeScene?.bookmarks ?? EMPTY_BOOKMARKS,
		isVisible: showBookmarkNotes,
	});
	const shouldTrackOverlayTime = Boolean(activeScene?.parallax);
	const selectOverlayTime = useCallback(
		(editor: EditorCore) =>
			shouldTrackOverlayTime
				? editor.playback.getCurrentTime()
				: ZERO_MEDIA_TIME,
		[shouldTrackOverlayTime],
	);
	const currentTime = useEditorPlayback(selectOverlayTime);

	const overlaySource = useMemo(
		() =>
			mergePreviewOverlaySources({
				sources: [
					getParallaxCanvasPreviewOverlaySource({
						scene: activeScene,
						canvasSize: project?.settings.canvasSize,
						currentTime,
						duration: sceneDuration,
						cameraOverride:
							cameraManPhase !== "idle" && cameraManSceneId === activeScene?.id
								? cameraManCurrent
								: null,
					}),
					getSafeAreaPreviewOverlaySource({
						isVisible: showSafeArea,
					}),
					getGuidePreviewOverlaySource({
						guideId: activeGuide,
					}),
					bookmarkSource,
				],
			}),
		[
			activeGuide,
			activeScene,
			bookmarkSource,
			cameraManCurrent,
			cameraManPhase,
			cameraManSceneId,
			currentTime,
			project?.settings.canvasSize,
			sceneDuration,
			showSafeArea,
		],
	);

	const overlayControls = useMemo(
		() =>
			overlaySource.definitions.map((overlay) =>
				createPreviewOverlayControl({ overlay, overlays }),
			),
		[overlaySource.definitions, overlays],
	);

	return (
		<PreviewPanel
			overlayControls={overlayControls}
			overlayInstances={overlaySource.instances}
			onOverlayVisibilityChange={setOverlayVisibility}
		/>
	);
}
