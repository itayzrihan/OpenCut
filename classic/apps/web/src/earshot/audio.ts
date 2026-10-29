import type { EarshotSpec } from "./types";

/** A source key includes every editable field; no encoded media or disk cache. */
export function earshotSourceKey(spec: EarshotSpec): string {
	return `earshot:${JSON.stringify(spec, (_key, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
				)
			: value,
	)}`;
}

type Pcm = { channels: Float32Array[]; sampleRate: number };
const cache = new Map<string, Pcm>();
const MAX_CACHE_BYTES = 32 * 1024 ** 2;
let cacheBytes = 0;

type Pending = {
	promise: Promise<Pcm>;
	controller: AbortController;
	readers: number;
};
const pending = new Map<string, Pending>();

async function sourcePcm({
	spec,
	signal,
}: {
	spec: EarshotSpec;
	signal?: AbortSignal;
}): Promise<Pcm> {
	signal?.throwIfAborted();
	const key = earshotSourceKey(spec);
	const cached = cache.get(key);
	if (cached) {
		cache.delete(key);
		cache.set(key, cached);
		return cached;
	}
	let task = pending.get(key);
	if (!task || task.controller.signal.aborted) {
		const controller = new AbortController();
		const frozen = structuredClone(spec);
		const promise = (async () => {
			const { renderEarshotSound } = await import("./render");
			const pcm = await renderEarshotSound({
				spec: frozen,
				signal: controller.signal,
			});
			controller.signal.throwIfAborted();
			const bytes = pcm.channels.reduce(
				(n, channel) => n + channel.byteLength,
				0,
			);
			while (cacheBytes + bytes > MAX_CACHE_BYTES && cache.size) {
				const [oldKey, old] = cache.entries().next().value!;
				cache.delete(oldKey);
				cacheBytes -= old.channels.reduce(
					(n, channel) => n + channel.byteLength,
					0,
				);
			}
			if (bytes <= MAX_CACHE_BYTES && !cache.has(key)) {
				cache.set(key, pcm);
				cacheBytes += bytes;
			}
			return pcm;
		})();
		task = { promise, controller, readers: 0 };
		pending.set(key, task);
		const owned = task;
		const cleanup = () => {
			if (pending.get(key) === owned) pending.delete(key);
		};
		void promise.then(cleanup, cleanup);
	}
	const active = task;
	active.readers++;
	return new Promise<Pcm>((resolve, reject) => {
		let done = false;
		const release = () => {
			if (done) return false;
			done = true;
			signal?.removeEventListener("abort", abort);
			active.readers--;
			if (!active.readers && pending.get(key) === active)
				active.controller.abort();
			return true;
		};
		const abort = () => {
			if (release())
				reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		void active.promise.then(
			(value) => {
				if (release()) resolve(value);
			},
			(error) => {
				if (release()) reject(error);
			},
		);
	});
}

export async function resolveEarshotBuffer({
	spec,
	context,
	signal,
}: {
	spec: EarshotSpec;
	context: BaseAudioContext;
	signal?: AbortSignal;
}): Promise<AudioBuffer> {
	const pcm = await sourcePcm({ spec, signal });
	signal?.throwIfAborted();
	const buffer = context.createBuffer(
		pcm.channels.length,
		pcm.channels[0].length,
		pcm.sampleRate,
	);
	pcm.channels.forEach((channel, index) =>
		buffer.copyToChannel(new Float32Array(channel), index),
	);
	return buffer;
}

/** Preserve the source clock after trimming, splitting, seeking and retiming. */
export function sliceEarshotBuffer({
	buffer,
	context,
	start,
	end,
}: {
	buffer: AudioBuffer;
	context: BaseAudioContext;
	start: number;
	end: number;
}): AudioBuffer {
	const first = Math.round(start * buffer.sampleRate);
	const length = Math.max(1, Math.round((end - start) * buffer.sampleRate));
	const output = context.createBuffer(
		buffer.numberOfChannels,
		length,
		buffer.sampleRate,
	);
	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		const from = Math.max(0, first),
			to = Math.min(buffer.length, first + length);
		if (to > from)
			output.copyToChannel(
				buffer.getChannelData(channel).slice(from, to),
				channel,
				Math.max(0, -first),
			);
	}
	return output;
}

export async function previewEarshotSound({
	spec,
	signal,
	onEnded,
}: {
	spec: EarshotSpec;
	signal?: AbortSignal;
	onEnded?: () => void;
}): Promise<() => void> {
	const context = new AudioContext();
	const stop = () => {
		if (context.state !== "closed") void context.close().catch(() => {});
	};
	signal?.addEventListener("abort", stop, { once: true });
	try {
		await context.resume();
		const buffer = await resolveEarshotBuffer({ spec, context, signal });
		signal?.throwIfAborted();
		const source = context.createBufferSource();
		source.buffer = buffer;
		source.connect(context.destination);
		source.onended = () => {
			signal?.removeEventListener("abort", stop);
			stop();
			onEnded?.();
		};
		source.start();
		return stop;
	} catch (error) {
		signal?.removeEventListener("abort", stop);
		stop();
		throw error;
	}
}
