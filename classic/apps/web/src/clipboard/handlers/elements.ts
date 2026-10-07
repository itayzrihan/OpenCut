import type { ClipboardHandler } from "../types";

export const ElementsClipboardHandler = {
	type: "elements",

	canCopy({ selectedElements }) {
		return selectedElements.length > 0;
	},

	copy({ editor, selectedElements }) {
		if (selectedElements.length === 0) {
			return null;
		}

		const { items, sourceProjectId } =
			editor.command.copyClassicTimelineElements(selectedElements);

		if (items.length === 0) {
			return null;
		}

		return {
			type: "elements",
			sourceProjectId,
			items,
		};
	},

	paste({ entry, context }) {
		if (entry.items.length === 0) {
			return null;
		}

		return {
			executeCanonical: () =>
				context.editor.command.pasteClassicTimelineElements({
					time: context.time,
					items: entry.items,
					sourceProjectId: entry.sourceProjectId,
				}),
		};
	},
} satisfies ClipboardHandler<"elements">;
