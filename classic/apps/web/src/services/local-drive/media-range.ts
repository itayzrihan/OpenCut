// Media decoders issue open-ended ranges and cancel when their read-ahead
// buffer is full. Bound each response as well: a slow cancellation must not
// let the HTTP host buffer/stream the remaining tens of GB of a camera file.
// Decoders resume from Content-Range when they need the next chunk.
export const MEDIA_RANGE_BYTES = 8 * 1024 * 1024;

export function mediaRangeEnd({
	start,
	requestedEnd,
	size,
}: {
	start: number;
	requestedEnd: string;
	size: number;
}): number {
	return Math.min(
		size - 1,
		requestedEnd ? Number(requestedEnd) : start + MEDIA_RANGE_BYTES - 1,
	);
}
