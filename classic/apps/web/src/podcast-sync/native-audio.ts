import type { BrowserMediaSource } from "@/media/source";

export function syncAudioUrl({
	asset,
	mode,
	startSeconds,
	durationSeconds,
}: {
	asset: BrowserMediaSource;
	mode: "energy" | "waveform" | "info" | "fingerprint";
	startSeconds?: number;
	durationSeconds?: number;
}) {
	if (asset.file || !asset.url) return null;
	const url = new URL(asset.url, self.location.origin);
	if (
		url.origin !== self.location.origin ||
		url.pathname !== "/api/local-drive/media"
	)
		return null;
	url.searchParams.set("syncAudio", mode);
	if (startSeconds != null) url.searchParams.set("start", String(startSeconds));
	if (durationSeconds != null)
		url.searchParams.set("seconds", String(durationSeconds));
	return url;
}

export async function readNativeSyncAudio({
	asset,
	startSeconds,
	durationSeconds,
	waveform,
	fingerprint,
	signal,
}: {
	asset: BrowserMediaSource;
	startSeconds?: number;
	durationSeconds?: number;
	waveform?: boolean;
	fingerprint?: boolean;
	signal?: AbortSignal;
}) {
	const url = syncAudioUrl({
		asset,
		mode: fingerprint ? "fingerprint" : waveform ? "waveform" : "energy",
		startSeconds,
		durationSeconds,
	});
	if (!url) return null;
	try {
		const response = await fetch(url, {
			credentials: "same-origin",
			cache: "no-store",
			signal,
		});
		if (
			!response.ok ||
			!response.headers
				.get("content-type")
				?.startsWith("application/octet-stream")
		)
			return null;
		const data = await response.arrayBuffer();
		return (fingerprint || data.byteLength > 0) && data.byteLength % 4 === 0
			? new Float32Array(data)
			: null;
	} catch {
		return null;
	}
}
