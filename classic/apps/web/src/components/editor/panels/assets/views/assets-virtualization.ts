export const MEDIA_GRID_ITEM_WIDTH_PX = 112;
export const MEDIA_GRID_GAP_PX = 16;
export const MEDIA_GRID_ROW_HEIGHT_PX = 128;
export const MEDIA_COMPACT_ROW_HEIGHT_PX = 38;
export const MEDIA_LIST_OVERSCAN_ROWS = 6;
export const MEDIA_LIST_FALLBACK_HEIGHT_PX = 480;

export type MediaVirtualViewMode = "grid" | "list";

export function getMediaGridColumnCount({ width }: { width: number }) {
	if (!Number.isFinite(width) || width <= 0) {
		return 1;
	}

	return Math.max(
		1,
		Math.floor(
			(width + MEDIA_GRID_GAP_PX) /
				(MEDIA_GRID_ITEM_WIDTH_PX + MEDIA_GRID_GAP_PX),
		),
	);
}

export function getMediaVirtualRowCount({
	entryCount,
	mode,
	columnCount,
}: {
	entryCount: number;
	mode: MediaVirtualViewMode;
	columnCount: number;
}) {
	if (mode === "grid") {
		return Math.ceil(entryCount / Math.max(1, columnCount));
	}

	return entryCount;
}

export function getMediaVirtualRowEntries<T>({
	entries,
	mode,
	columnCount,
	rowIndex,
}: {
	entries: T[];
	mode: MediaVirtualViewMode;
	columnCount: number;
	rowIndex: number;
}) {
	if (mode !== "grid") {
		return entries[rowIndex] ? [entries[rowIndex]] : [];
	}

	const safeColumnCount = Math.max(1, columnCount);
	const start = rowIndex * safeColumnCount;
	return entries.slice(start, start + safeColumnCount);
}
