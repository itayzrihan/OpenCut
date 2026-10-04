export interface HyperframesMediaBridge {
	ready: () => Promise<void>;
	finishSeek: () => Promise<void>;
}

/** Native decoding stays in the isolated browser. The pinned runtime owns media
 * timing, trim/rate/loop rules and the async drawing completion barrier. */
export function hyperframesMediaBridgeScript(): string {
	return `(${installHyperframesMediaBridge.toString()})();`;
}

/** Stringified for live documents and installed directly in capture pages. */
export function installHyperframesMediaBridge(): void {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Pinned runtime hooks inside the isolated render document.
	const page = window as unknown as {
		__opencutMedia?: HyperframesMediaBridge;
		__hfWaitForSeekCompletion?: () => Promise<void>;
		__hfReseekGpu?: (time: number) => void;
		__player?: { getTime: () => number };
	};
	const videos = () => [...document.querySelectorAll("video")];
	const waitForVideo = (video: HTMLVideoElement) => {
		if (!video.currentSrc && !video.src && !video.querySelector("source[src]"))
			return Promise.resolve();
		if (video.error)
			return Promise.reject(new Error("HyperFrames could not decode video"));
		if (video.readyState >= video.HAVE_CURRENT_DATA && !video.seeking)
			return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const check = () => {
				if (video.error)
					finish(new Error("HyperFrames could not decode video"));
				else if (video.readyState >= video.HAVE_CURRENT_DATA && !video.seeking)
					finish();
			};
			const finish = (error?: Error) => {
				clearTimeout(timer);
				for (const name of ["loadeddata", "seeked", "error"])
					video.removeEventListener(name, check);
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(
				() => finish(new Error("HyperFrames video did not become ready")),
				10_000,
			);
			for (const name of ["loadeddata", "seeked", "error"])
				video.addEventListener(name, check);
			video.preload = "auto";
			check();
		});
	};
	page.__opencutMedia = {
		ready: async () => {
			await Promise.all(videos().map(waitForVideo));
			await page.__hfWaitForSeekCompletion?.();
		},
		finishSeek: async () => {
			// Native media and asynchronous hf-seek drawings share this barrier.
			await page.__hfWaitForSeekCompletion?.();
			const media = videos();
			await Promise.all(media.map(waitForVideo));
			// The initial GPU draw may have sampled the previous video frame.
			// Use the runtime's sampled time, including its sub-frame seek mode.
			if (media.length && document.querySelector("canvas")) {
				page.__hfReseekGpu?.(page.__player!.getTime());
				await page.__hfWaitForSeekCompletion?.();
			}
		},
	};
}
