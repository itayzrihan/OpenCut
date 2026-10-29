"use client";
import { useEffect, useState } from "react";
import type { EarshotSpec } from "./types";
import { earshotSourceKey, resolveEarshotBuffer } from "./audio";

export function useEarshotBuffer(spec?: EarshotSpec): AudioBuffer | undefined {
	const key = spec ? earshotSourceKey(spec) : undefined;
	const [resolved, setResolved] = useState<{
		key: string;
		buffer: AudioBuffer;
	}>();
	useEffect(() => {
		if (!key || !spec) return;
		const controller = new AbortController();
		void resolveEarshotBuffer({
			spec,
			context: new OfflineAudioContext(2, 1, 48000),
			signal: controller.signal,
		})
			.then((buffer) => {
				if (!controller.signal.aborted) setResolved({ key, buffer });
			})
			.catch((error) => {
				if (!controller.signal.aborted)
					console.warn("Earshot waveform unavailable", error);
			});
		return () => controller.abort();
		// key includes every serialized source field; object identity is not a change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	return resolved?.key === key ? resolved?.buffer : undefined;
}
