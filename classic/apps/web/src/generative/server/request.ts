/** Bound the actual stream, including chunked uploads with no Content-Length. */
export async function requestBytes({
	request,
	limit,
}: {
	request: Request;
	limit: number;
}) {
	if (Number(request.headers.get("content-length") ?? 0) > limit)
		throw new Error("Request exceeds size limit");
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new Error("Request exceeds size limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}
