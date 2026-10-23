// @opencut-test-runner: node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { measureMusicDuration } from "../music-duration";

test("real range reader measures WAV headers in a background process without DOM playback", async () => {
	const pcm = Buffer.alloc(44 + 4800 * 2);
	pcm.write("RIFF", 0);
	pcm.writeUInt32LE(pcm.length - 8, 4);
	pcm.write("WAVEfmt ", 8);
	pcm.writeUInt32LE(16, 16);
	pcm.writeUInt16LE(1, 20);
	pcm.writeUInt16LE(1, 22);
	pcm.writeUInt32LE(48000, 24);
	pcm.writeUInt32LE(96000, 28);
	pcm.writeUInt16LE(2, 32);
	pcm.writeUInt16LE(16, 34);
	pcm.write("data", 36);
	pcm.writeUInt32LE(pcm.length - 44, 40);
	let requests = 0;
	const server = createServer((req, res) => {
		requests++;
		const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
		const start = range ? Number(range[1]) : 0;
		const end =
			range && range[2]
				? Math.min(Number(range[2]), pcm.length - 1)
				: pcm.length - 1;
		res.writeHead(range ? 206 : 200, {
			"Content-Type": "audio/wav",
			"Content-Length": end - start + 1,
			"Accept-Ranges": "bytes",
			...(range
				? { "Content-Range": `bytes ${start}-${end}/${pcm.length}` }
				: {}),
		});
		res.end(pcm.subarray(start, end + 1));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw Error("Missing server port");
		const duration = await measureMusicDuration({
			url: `http://127.0.0.1:${address.port}/music.wav`,
			signal: new AbortController().signal,
		});
		assert(Math.abs(duration - 0.1) < 1e-9);
		assert(requests > 0);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
