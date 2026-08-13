import type { TimelineElement } from "@/timeline";

type BulkSelectionEntry = {
	element: Pick<TimelineElement, "type">;
};

const VIDEO_BULK_EDITABLE_TAB_IDS = new Set([
	"transform",
	"audio",
	"blending",
]);

export function canBulkEditPropertiesSelection({
	entries,
	selectedCount,
}: {
	entries: readonly BulkSelectionEntry[];
	selectedCount: number;
}): boolean {
	const firstElement = entries[0]?.element;
	if (!firstElement || entries.length !== selectedCount) return false;
	if (firstElement.type !== "text" && firstElement.type !== "video") {
		return false;
	}

	return entries.every(
		(entry) => entry.element.type === firstElement.type,
	);
}

export function isBulkEditablePropertiesTab({
	elementType,
	tabId,
}: {
	elementType: TimelineElement["type"];
	tabId: string;
}): boolean {
	if (elementType !== "video") return true;
	return VIDEO_BULK_EDITABLE_TAB_IDS.has(tabId);
}
