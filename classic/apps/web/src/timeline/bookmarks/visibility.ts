import type { Bookmark } from "@/timeline";
import { ZERO_MEDIA_TIME } from "@/wasm";

export interface BookmarkVisibilityIndex {
	isSortedByTime: boolean;
	maxDuration: number;
}

export function getBookmarkVisibilityIndex({
	bookmarks,
}: {
	bookmarks: Bookmark[];
}): BookmarkVisibilityIndex {
	let isSortedByTime = true;
	let maxDuration = ZERO_MEDIA_TIME;
	let previousTime = -Infinity;

	for (const bookmark of bookmarks) {
		if (bookmark.time < previousTime) {
			isSortedByTime = false;
		}
		previousTime = bookmark.time;

		const duration = bookmark.duration ?? ZERO_MEDIA_TIME;
		if (duration > maxDuration) {
			maxDuration = duration;
		}
	}

	return { isSortedByTime, maxDuration };
}

export function getVisibleBookmarks({
	bookmarks,
	visibilityIndex,
	visibleStartTime,
	visibleEndTime,
	draggedBookmarkTime = null,
}: {
	bookmarks: Bookmark[];
	visibilityIndex: BookmarkVisibilityIndex;
	visibleStartTime: number;
	visibleEndTime: number;
	draggedBookmarkTime?: number | null;
}): Bookmark[] {
	if (bookmarks.length === 0) return [];
	if (
		!Number.isFinite(visibleStartTime) ||
		!Number.isFinite(visibleEndTime) ||
		visibleEndTime < visibleStartTime
	) {
		return bookmarks;
	}

	if (!visibilityIndex.isSortedByTime) {
		return bookmarks.filter((bookmark) =>
			shouldShowBookmark({
				bookmark,
				visibleStartTime,
				visibleEndTime,
				draggedBookmarkTime,
			}),
		);
	}

	const startIndex = lowerBoundBookmarkTime({
		bookmarks,
		time: Math.max(0, visibleStartTime - visibilityIndex.maxDuration),
	});
	const endIndex = upperBoundBookmarkTime({
		bookmarks,
		time: visibleEndTime,
	});
	const visibleBookmarks: Bookmark[] = [];

	for (let index = startIndex; index < endIndex; index += 1) {
		const bookmark = bookmarks[index];
		if (
			shouldShowBookmark({
				bookmark,
				visibleStartTime,
				visibleEndTime,
				draggedBookmarkTime,
			})
		) {
			visibleBookmarks.push(bookmark);
		}
	}

	if (draggedBookmarkTime == null) {
		return visibleBookmarks;
	}

	const draggedIndex = findBookmarkIndexAtTime({
		bookmarks,
		time: draggedBookmarkTime,
	});
	if (
		draggedIndex === -1 ||
		(draggedIndex >= startIndex && draggedIndex < endIndex)
	) {
		return visibleBookmarks;
	}

	if (draggedIndex < startIndex) {
		return [bookmarks[draggedIndex], ...visibleBookmarks];
	}

	return [...visibleBookmarks, bookmarks[draggedIndex]];
}

function shouldShowBookmark({
	bookmark,
	visibleStartTime,
	visibleEndTime,
	draggedBookmarkTime,
}: {
	bookmark: Bookmark;
	visibleStartTime: number;
	visibleEndTime: number;
	draggedBookmarkTime: number | null;
}) {
	if (draggedBookmarkTime != null && bookmark.time === draggedBookmarkTime) {
		return true;
	}

	const bookmarkEnd = bookmark.time + (bookmark.duration ?? ZERO_MEDIA_TIME);
	return bookmarkEnd >= visibleStartTime && bookmark.time <= visibleEndTime;
}

function lowerBoundBookmarkTime({
	bookmarks,
	time,
}: {
	bookmarks: Bookmark[];
	time: number;
}) {
	let low = 0;
	let high = bookmarks.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (bookmarks[mid].time < time) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

function upperBoundBookmarkTime({
	bookmarks,
	time,
}: {
	bookmarks: Bookmark[];
	time: number;
}) {
	let low = 0;
	let high = bookmarks.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (bookmarks[mid].time <= time) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

function findBookmarkIndexAtTime({
	bookmarks,
	time,
}: {
	bookmarks: Bookmark[];
	time: number;
}) {
	const index = lowerBoundBookmarkTime({ bookmarks, time });
	return bookmarks[index]?.time === time ? index : -1;
}
