const MOVIE_EPOCH_OFFSET = 2_082_844_800;

/** Read the creation stamp without loading the potentially large sample tables. */
export async function readMovieCaptureTime(file: Blob) {
	const movie = await findBox({ file, start: 0, end: file.size, type: "moov" });
	if (!movie) return null;
	const header = await findBox({ file, ...movie, type: "mvhd" });
	if (!header || header.end - header.start < 8) return null;
	const data = new DataView(
		await file
			.slice(header.start, Math.min(header.end, header.start + 12))
			.arrayBuffer(),
	);
	const version = data.getUint8(0);
	const stamp =
		version === 0
			? data.getUint32(4)
			: version === 1 && data.byteLength >= 12
				? Number(data.getBigUint64(4))
				: 0;
	const time = (stamp - MOVIE_EPOCH_OFFSET) * 1000;
	return time >= Date.UTC(1990, 0, 1) && time < Date.UTC(2200, 0, 1)
		? time
		: null;
}

async function findBox({
	file,
	start,
	end,
	type,
}: {
	file: Blob;
	start: number;
	end: number;
	type: string;
}) {
	for (
		let offset = start, count = 0;
		offset + 8 <= end && count < 128;
		count++
	) {
		const bytes = await file
			.slice(offset, Math.min(end, offset + 16))
			.arrayBuffer();
		const data = new DataView(bytes);
		const size32 = data.getUint32(0);
		const header = size32 === 1 ? 16 : 8;
		const size =
			size32 === 0
				? end - offset
				: size32 === 1 && data.byteLength >= header
					? Number(data.getBigUint64(8))
					: size32;
		if (!Number.isSafeInteger(size) || size < header || size > end - offset)
			return null;
		const name = String.fromCharCode(...new Uint8Array(bytes, 4, 4));
		if (name === type) return { start: offset + header, end: offset + size };
		offset += size;
	}
	return null;
}
