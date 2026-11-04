/** Chat-only small observation; original file bytes remain untouched. */
export async function imageObservation(blob: Blob): Promise<string> {
	const bitmap = await createImageBitmap(blob);
	try {
		const ratio = Math.min(1, 384 / Math.max(bitmap.width, bitmap.height)),
			canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
		canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Image preview unavailable");
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return canvas.toDataURL("image/jpeg", 0.55);
	} finally {
		bitmap.close();
	}
}

/** Observe three frames of a video reference without changing/retiming its source. */
export async function videoObservations(blob: Blob): Promise<string[]> {
	const url = URL.createObjectURL(blob),
		video = document.createElement("video");
	video.preload = "auto";
	video.muted = true;
	video.playsInline = true;
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Video reference preview timed out")),
				15000,
			);
			video.onloadeddata = () => {
				clearTimeout(timer);
				resolve();
			};
			video.onerror = () => {
				clearTimeout(timer);
				reject(new Error("Unsupported video codec for chat preview"));
			};
			video.src = url;
		});
		if (!Number.isFinite(video.duration) || !video.videoWidth)
			throw new Error("Video reference has no readable frames");
		const frames: string[] = [];
		for (const fraction of [0.05, 0.5, 0.95]) {
			const time = Math.min(video.duration - 0.001, video.duration * fraction);
			if (Math.abs(video.currentTime - time) > 0.001)
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error("Video seek timed out")),
						10000,
					);
					video.onseeked = () => {
						clearTimeout(timer);
						resolve();
					};
					video.currentTime = time;
				});
			const canvas = document.createElement("canvas"),
				scale = Math.min(
					1,
					384 / Math.max(video.videoWidth, video.videoHeight),
				);
			canvas.width = Math.round(video.videoWidth * scale);
			canvas.height = Math.round(video.videoHeight * scale);
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Video preview unavailable");
			context.drawImage(video, 0, 0, canvas.width, canvas.height);
			frames.push(canvas.toDataURL("image/jpeg", 0.55));
		}
		return frames;
	} finally {
		video.removeAttribute("src");
		video.load();
		URL.revokeObjectURL(url);
	}
}
