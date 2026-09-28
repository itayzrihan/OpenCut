/** Single-range HTTP adapter. Invalid/unsupported ranges are rejected. */
export function readByteRange(header: string | null, size: number) {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match || (!match[1] && !match[2]) || size === 0) return { invalid: true as const };
	const first = match[1] ? Number(match[1]) : null;
	const last = match[2] ? Number(match[2]) : null;
	if ([first, last].some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0))) return { invalid: true as const };
	const start = first ?? Math.max(0, size - last!);
	const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
	if (start >= size || start > end) return { invalid: true as const };
	return { invalid: false as const, start, end };
}
