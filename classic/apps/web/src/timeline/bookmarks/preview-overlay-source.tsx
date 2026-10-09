import type { Bookmark } from "@/timeline";
import { useCallback, useMemo } from "react";
import { useEditorPlayback } from "@/editor/use-editor";
import type { EditorCore } from "@/core";
import {
	EMPTY_PREVIEW_OVERLAY_SOURCE_RESULT,
	type PreviewOverlayDefinition,
	type PreviewOverlaySourceResult,
} from "@/preview/overlays";
import { getBookmarksActiveAtTime } from "./utils";
import type { MediaTime } from "@/wasm";

export const bookmarkNotesPreviewOverlay: PreviewOverlayDefinition = {
	id: "bookmark-notes",
	label: "Show bookmark notes",
	defaultVisible: true,
};

function BookmarkNotesOverlay({
	bookmarks,
}: {
	bookmarks: Array<{ time: MediaTime; note: string; color?: string }>;
}) {
	return (
		<div className="flex flex-col gap-1.5" aria-live="polite">
			{bookmarks.map((bookmark) => (
				<div
					key={bookmark.time}
					className="flex max-w-[min(200px,50vw)] px-2.5 py-1.5 text-left text-white text-xs shadow-md backdrop-blur-sm"
					style={{
						backgroundColor: "rgb(0 0 0 / 0.5)",
						borderLeft: bookmark.color
							? `3px solid ${bookmark.color}`
							: "3px solid var(--primary)",
					}}
				>
					{bookmark.note}
				</div>
			))}
		</div>
	);
}

export function getBookmarkPreviewOverlaySource({
	bookmarks,
	time,
	isVisible,
}: {
	bookmarks: Bookmark[];
	time: MediaTime;
	isVisible: boolean;
}): PreviewOverlaySourceResult {
	return createBookmarkPreviewOverlaySource({
		bookmarks: getBookmarksActiveAtTime({ bookmarks, time }),
		isVisible,
	});
}

/** Subscribe to the displayed notes, so unchanged intervals (including an
 * empty timeline) don't rerender the entire preview on every transport tick. */
export function useBookmarkPreviewOverlaySource({
	bookmarks,
	isVisible,
}: {
	bookmarks: Bookmark[];
	isVisible: boolean;
}): PreviewOverlaySourceResult {
	const selectNotes = useCallback(
		(editor: EditorCore) =>
			isVisible
				? getBookmarksActiveAtTime({
						bookmarks,
						time: editor.playback.getCurrentTime(),
					}).filter((bookmark) => bookmark.note?.trim())
				: [],
		[bookmarks, isVisible],
	);
	// useEditorPlayback compares the array's bookmark identities, preserving
	// its snapshot until notes enter/leave the interval or the document changes.
	const activeNotes = useEditorPlayback(selectNotes);
	return useMemo(
		() =>
			createBookmarkPreviewOverlaySource({ bookmarks: activeNotes, isVisible }),
		[activeNotes, isVisible],
	);
}

function createBookmarkPreviewOverlaySource({
	bookmarks,
	isVisible,
}: {
	bookmarks: Bookmark[];
	isVisible: boolean;
}): PreviewOverlaySourceResult {
	const bookmarksWithNotes = bookmarks.flatMap((bookmark) => {
		if (bookmark.note == null || bookmark.note.trim() === "") {
			return [];
		}

		return [
			{
				time: bookmark.time,
				note: bookmark.note,
				color: bookmark.color,
			},
		];
	});

	if (!isVisible || bookmarksWithNotes.length === 0) {
		return {
			...EMPTY_PREVIEW_OVERLAY_SOURCE_RESULT,
			definitions: [bookmarkNotesPreviewOverlay],
		};
	}

	return {
		definitions: [bookmarkNotesPreviewOverlay],
		instances: [
			{
				id: bookmarkNotesPreviewOverlay.id,
				mount: { kind: "hud", anchor: "top-left", order: 0 },
				plane: "over-interaction",
				pointerEvents: "none",
				render: () => <BookmarkNotesOverlay bookmarks={bookmarksWithNotes} />,
			},
		],
	};
}
