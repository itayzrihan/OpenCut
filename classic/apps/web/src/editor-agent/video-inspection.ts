import { ALL_FORMATS, BufferSource, Input } from "mediabunny";

/** Inspect the produced container, not the requested export options. */
export async function inspectEncodedVideo({
	buffer,
	signal,
}: {
	buffer: ArrayBuffer;
	signal: AbortSignal;
}) {
	signal.throwIfAborted();
	if (buffer.byteLength > 64 * 1024 * 1024)
		throw new Error("Export exceeds the agent artifact limit");
	const input = new Input({
		formats: ALL_FORMATS,
		source: new BufferSource(buffer),
	});
	const abort = () => input.dispose();
	signal.addEventListener("abort", abort, { once: true });
	try {
		const video = await input.getPrimaryVideoTrack();
		if (!video) throw new Error("Export has no video track");
		const [durationSeconds, audio, videos, stats] = await Promise.all([
			video.computeDuration(),
			input.getAudioTracks(),
			input.getVideoTracks(),
			video.computePacketStats(),
		]);
		signal.throwIfAborted();
		if (
			!(durationSeconds > 0) ||
			!stats.packetCount ||
			!(stats.averagePacketRate > 0)
		)
			throw new Error("Export contains no timed video packets");
		return {
			durationSeconds,
			width: video.displayWidth,
			height: video.displayHeight,
			frameRate: stats.averagePacketRate,
			packetCount: stats.packetCount,
			videoTracks: videos.length,
			audioTracks: audio.length,
			codec: video.codec ?? "unknown",
		};
	} finally {
		signal.removeEventListener("abort", abort);
		input.dispose();
	}
}
