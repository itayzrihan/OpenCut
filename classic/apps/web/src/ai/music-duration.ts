/** Metadata IO for background editing: no detached media element or playback required. */
import { ALL_FORMATS, Input } from "mediabunny";
import { createMediaSource } from "@/media/source";

export async function measureMusicDuration({
	url,
	signal,
}: {
	url: string;
	signal: AbortSignal;
}): Promise<number> {
	signal.throwIfAborted();
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
	const input = new Input({
		formats: ALL_FORMATS,
		source: createMediaSource({
			url,
			urlOptions: { maxCacheSize: 8 * 1024 ** 2, parallelism: 1 },
		}),
	});
	const abort = () => input.dispose();
	bounded.addEventListener("abort", abort, { once: true });
	try {
		const track = await input.getPrimaryAudioTrack();
		bounded.throwIfAborted();
		if (!track) throw new Error("The selected music has no audio track");
		const duration = await track.computeDuration();
		bounded.throwIfAborted();
		if (!Number.isFinite(duration) || duration <= 0)
			throw new Error("Cannot verify the selected music duration");
		return duration;
	} finally {
		bounded.removeEventListener("abort", abort);
		input.dispose();
	}
}
