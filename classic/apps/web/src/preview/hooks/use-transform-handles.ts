import { useEffect, useMemo, useReducer, useState } from "react";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import type { OnSnapLinesChange } from "@/preview/hooks/use-preview-interaction";
import {
	useEditor,
	useEditorMediaAsset,
	useEditorPlayback,
	useEditorProject,
	useEditorSelection,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import { getDisplayTracks, hasMediaId } from "@/timeline";
import { isVisualElement } from "@/timeline/element-utils";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { useShiftKey } from "@/hooks/use-shift-key";
import { registerCanceller } from "@/editor/cancel-interaction";
import {
	TransformHandleController,
	type TransformHandleDeps,
} from "@/preview/controllers/transform-handle-controller";

export function useTransformHandles({
	onSnapLinesChange,
}: {
	onSnapLinesChange?: OnSnapLinesChange;
}) {
	const viewport = usePreviewViewport();
	const editor = useEditor();
	const isShiftHeldRef = useShiftKey();
	const selectedElements = useEditorSelection((e) =>
		e.selection.getSelectedElements(),
	);
	const tracks = useEditorTimelineScenes(
		(e) => e.timeline.getPreviewTracks() ?? e.scenes.getActiveScene().tracks,
	);
	const selectedVisualElement = useMemo(() => {
		if (selectedElements.length !== 1) {
			return null;
		}
		const selected = selectedElements[0];
		if (!selected) {
			return null;
		}

		const track = getDisplayTracks({ tracks }).find(
			(candidate) => candidate.id === selected.trackId,
		);
		const element = track?.elements.find(
			(candidate) => candidate.id === selected.elementId,
		);
		return element && isVisualElement(element) ? element : null;
	}, [selectedElements, tracks]);
	const currentTime = useEditorPlayback((e) =>
		selectedVisualElement ? e.playback.getCurrentTime() : 0,
	);
	const selectedMediaId =
		selectedVisualElement && hasMediaId(selectedVisualElement)
			? selectedVisualElement.mediaId
			: null;
	const selectedMediaAsset = useEditorMediaAsset({ mediaId: selectedMediaId });
	const canvasSize = useEditorProject(
		(e) => e.project.getActive().settings.canvasSize,
	);
	const deps: TransformHandleDeps = {
		viewport,
		input: {
			isShiftHeld: () => isShiftHeldRef.current,
		},
		scene: {
			getSelectedElements: () => selectedElements,
			getTracks: () => tracks,
			getCurrentTime: () => currentTime,
			getSelectedMediaAsset: () => selectedMediaAsset,
			getCanvasSize: () => canvasSize,
		},
		timeline: {
			previewElements: (updates) =>
				editor.timeline.previewElements({ updates }),
			commitPreview: () => editor.timeline.commitPreview(),
			discardPreview: () => editor.timeline.discardPreview(),
		},
		preview: {
			onSnapLinesChange,
		},
	};
	const depsRef = useCommittedRef(deps);
	const [controller] = useState(
		() => new TransformHandleController({ depsRef }),
	);

	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => controller.subscribe(rerender), [controller]);

	useEffect(() => {
		if (!controller.isActive) return;
		return registerCanceller({ fn: () => controller.cancel() });
	}, [controller, controller.isActive]);

	useEffect(() => () => controller.destroy(), [controller]);

	const selectedWithBounds = controller.selectedWithBounds;
	const hasVisualSelection = selectedWithBounds !== null;

	return {
		selectedWithBounds,
		hasVisualSelection,
		activeHandle: controller.activeHandle,
		handleCornerPointerDown: controller.onCornerPointerDown,
		handleEdgePointerDown: controller.onEdgePointerDown,
		handleRotationPointerDown: controller.onRotationPointerDown,
		handlePointerMove: controller.onPointerMove,
		handlePointerUp: controller.onPointerUp,
	};
}
