/** Bound bytes while reading, before allocation or JSON parsing. */
export async function readBoundedBody(
	request: Request,
	maximumBytes: number,
): Promise<ArrayBuffer> {
	const size = request.headers.get("content-length");
	if (size && (!/^\d+$/.test(size) || Number(size) > maximumBytes))
		throw new Error("Request too large");
	if (!request.body) return new ArrayBuffer(0);
	const reader = request.body.getReader(),
		chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maximumBytes) {
				await reader.cancel();
				throw new Error("Request too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output.buffer;
}
