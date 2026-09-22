interface WhisperSegment {
	text?: string;
	timestamps?: {
		from?: string;
		to?: string;
	};
	offsets?: {
		from?: number;
		to?: number;
	};
	tokens?: Array<{
		text?: string;
		t_dtw?: number;
		timestamps?: {
			from?: string;
			to?: string;
		};
		offsets?: {
			from?: number;
			to?: number;
		};
	}>;
}

interface WordTiming {
	text: string;
	start: number;
	end: number;
	dtwStart?: number;
	dtwEnd?: number;
	segmentStart?: number;
	segmentEnd?: number;
}

function parseTimestamp(value?: string) {
	if (!value) return 0;
	const parts = value.trim().replace(",", ".").split(":").map(Number);
	if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
	if (parts.length === 2) return parts[0] * 60 + parts[1];
	return Number(value) || 0;
}

export function segmentStart(segment: WhisperSegment) {
	if (typeof segment.offsets?.from === "number")
		return segment.offsets.from / 1000;
	return parseTimestamp(segment.timestamps?.from);
}

export function segmentEnd(segment: WhisperSegment) {
	if (typeof segment.offsets?.to === "number") return segment.offsets.to / 1000;
	return parseTimestamp(segment.timestamps?.to);
}

function tokenStart({
	token,
	fallback,
}: {
	token: NonNullable<WhisperSegment["tokens"]>[number];
	fallback: number;
}) {
	if (typeof token.offsets?.from === "number") return token.offsets.from / 1000;
	return parseTimestamp(token.timestamps?.from) || fallback;
}

function tokenEnd({
	token,
	fallback,
}: {
	token: NonNullable<WhisperSegment["tokens"]>[number];
	fallback: number;
}) {
	if (typeof token.offsets?.to === "number") return token.offsets.to / 1000;
	return parseTimestamp(token.timestamps?.to) || fallback;
}

function tokenDtwSeconds(token: NonNullable<WhisperSegment["tokens"]>[number]) {
	const value = Number(token.t_dtw);
	return Number.isFinite(value) && value >= 0 ? value / 100 : null;
}

export function roundSeconds(value: number) {
	return Math.round(value * 1000) / 1000;
}

function cleanTokenText(text: string) {
	return text.replace(
		/\[_BEG_\]|\[_TT_\d+\]|\[_EOT_\]|\[_SOLM_\]|\[_PREV_\]|\[_NOT_\]/g,
		"",
	);
}

function isPunctuationOnly(text: string) {
	return /^[\s.,!?;:()[\]{}"'`\-.]+$/.test(text);
}

function finalizeWordTimings(words: WordTiming[]) {
	if (words.length === 0) return words;

	const centers = words.map((word) =>
		typeof word.dtwStart === "number" && typeof word.dtwEnd === "number"
			? (word.dtwStart + word.dtwEnd) / 2
			: null,
	);

	return words.map((word, index) => {
		const center = centers[index];
		if (center === null) {
			return {
				text: word.text,
				start: roundSeconds(Math.max(0, word.start)),
				end: roundSeconds(Math.max(word.end, word.start + 0.001)),
			};
		}

		const prevCenter = index > 0 ? centers[index - 1] : null;
		const nextCenter = index + 1 < centers.length ? centers[index + 1] : null;
		const segmentStartTime = Number.isFinite(word.segmentStart)
			? Number(word.segmentStart)
			: word.start;
		const segmentEndTime = Number.isFinite(word.segmentEnd)
			? Number(word.segmentEnd)
			: word.end;
		const midpointStart =
			prevCenter === null ? segmentStartTime : (prevCenter + center) / 2;
		const dtwStart =
			typeof word.dtwStart === "number" ? word.dtwStart : word.start;
		const dtwEnd = typeof word.dtwEnd === "number" ? word.dtwEnd : word.end;

		// Start captions no earlier than the aligned token onset.
		const start = Math.max(segmentStartTime, midpointStart, dtwStart);
		const end =
			nextCenter === null
				? Math.min(segmentEndTime, dtwEnd + 0.12)
				: (center + nextCenter) / 2;

		return {
			text: word.text,
			start: roundSeconds(Math.max(0, start)),
			end: roundSeconds(Math.max(end, start + 0.001)),
		};
	});
}

export function buildWords({ segments }: { segments: WhisperSegment[] }) {
	const words: WordTiming[] = [];

	for (const segment of segments) {
		const segmentStartTime = segmentStart(segment);
		const segmentEndTime = segmentEnd(segment);
		// whisper.cpp can emit a zero-duration decoding attempt before its
		// valid retry. Its repeated text and collapsed DTW tokens are not words
		// on the timeline (the segment response already excludes this attempt).
		if (segmentEndTime <= segmentStartTime) continue;
		let current: WordTiming | null = null;

		for (const token of segment.tokens || []) {
			const raw = cleanTokenText(token.text || "");
			if (!raw.trim()) continue;

			const start = tokenStart({ token, fallback: segmentStartTime });
			const end = tokenEnd({ token, fallback: segmentEndTime });
			const dtw = tokenDtwSeconds(token);
			const hasLeadingSpace = /^\s/.test(raw);
			const piece = raw.replace(/\s+/g, " ").trim();
			if (!piece) continue;

			if (isPunctuationOnly(piece)) {
				if (current) {
					current.text += piece;
					current.end = Math.max(current.end, end);
					if (dtw !== null) {
						current.dtwEnd = dtw;
					}
				}
				continue;
			}

			if (!current || hasLeadingSpace) {
				if (current) words.push(current);
				current = {
					text: piece,
					start,
					end: Math.max(end, start + 0.001),
					dtwStart: dtw ?? undefined,
					dtwEnd: dtw ?? undefined,
					segmentStart: segmentStartTime,
					segmentEnd: segmentEndTime,
				};
				continue;
			}

			current.text += piece;
			current.end = Math.max(current.end, end);
			if (dtw !== null) {
				current.dtwEnd = dtw;
				current.dtwStart ??= dtw;
			}
		}

		if (current) {
			words.push(current);
			continue;
		}

		const fallbackWords = (segment.text || "")
			.trim()
			.split(/\s+/)
			.filter(Boolean);
		if (fallbackWords.length === 0) continue;
		const duration = Math.max(0.1, segmentEndTime - segmentStartTime);
		const wordDuration = duration / fallbackWords.length;
		fallbackWords.forEach((text, index) => {
			words.push({
				text,
				start: segmentStartTime + index * wordDuration,
				end: segmentStartTime + (index + 1) * wordDuration,
			});
		});
	}

	return finalizeWordTimings(words);
}
