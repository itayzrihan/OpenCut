import type { SelectedKeyframeRef } from "@/animation/types";
import type { ClipboardHandler } from "../types";

function resolveSingleSourceElement({
	selectedKeyframes,
}: {
	selectedKeyframes: SelectedKeyframeRef[];
}) {
	const firstKeyframe = selectedKeyframes[0];
	if (!firstKeyframe) {
		return null;
	}

	const sourceElement = {
		trackId: firstKeyframe.trackId,
		elementId: firstKeyframe.elementId,
	};
	const isSingleSource = selectedKeyframes.every(
		(keyframe) =>
			keyframe.trackId === sourceElement.trackId &&
			keyframe.elementId === sourceElement.elementId,
	);

	return isSingleSource ? sourceElement : null;
}

export const KeyframesClipboardHandler = {
	type: "keyframes",
	canCopy({ selectedKeyframes }) {
		return selectedKeyframes.length > 0;
	},
	copy({ editor, selectedKeyframes }) {
		const sourceElement = resolveSingleSourceElement({ selectedKeyframes });
		if (!sourceElement) return null;
		const items = editor.command.copyClassicKeyframes({
			...sourceElement,
			keyframes: selectedKeyframes.map(({ propertyPath, keyframeId }) => ({
				propertyPath,
				keyframeId,
			})),
		});
		return items.length ? { type: "keyframes", sourceElement, items } : null;
	},
	paste({ entry, context: { editor, selectedElements, time } }) {
		const target = selectedElements[0];
		if (!target || !entry.items.length) return null;
		return {
			executeCanonical: () => {
				try {
					return editor.command.pasteClassicKeyframes({
						...target,
						time,
						items: entry.items,
					});
				} finally {
					editor.timeline.discardPreview();
				}
			},
		};
	},
} satisfies ClipboardHandler<"keyframes">;
