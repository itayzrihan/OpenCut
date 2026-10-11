import type { Media } from "./model";
import { writeStore, readStore } from "./storage";
export async function importMedia(
	file: File,
	projectId: string,
): Promise<Media> {
	const type = file.type.startsWith("video/")
		? "video"
		: file.type.startsWith("audio/")
			? "audio"
			: file.type.startsWith("image/")
				? "image"
				: null;
	if (!type) throw Error(`Unsupported media type: ${file.name}`);
	const id = crypto.randomUUID();
	const url = URL.createObjectURL(file);
	try {
		const meta = await new Promise<Partial<Media>>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(Error(`Media metadata timed out: ${file.name}`));
			}, 20000);
			const el = type === "image" ? new Image() : document.createElement(type);
			const cleanup = () => {
				clearTimeout(timer);
				el.onload = null;
				el.onerror = null;
				if (el instanceof HTMLMediaElement) {
					el.onloadedmetadata = null;
					el.removeAttribute("src");
					el.load();
				}
			};
			el.onerror = () => {
				cleanup();
				reject(Error(`Cannot decode ${file.name}`));
			};
			if (el instanceof HTMLImageElement)
				el.onload = () => {
					const data = { width: el.naturalWidth, height: el.naturalHeight };
					cleanup();
					resolve(data);
				};
			else {
				el.preload = "metadata";
				el.onloadedmetadata = () => {
					const data = {
						duration: el.duration,
						...(el instanceof HTMLVideoElement
							? { width: el.videoWidth, height: el.videoHeight }
							: {}),
					};
					cleanup();
					Number.isFinite(data.duration)
						? resolve(data)
						: reject(Error("Media has no finite duration"));
				};
			}
			el.src = url;
		});
		await writeStore("media", file, `${projectId}:${id}`);
		return { id, name: file.name, type, size: file.size, ...meta };
	} finally {
		URL.revokeObjectURL(url);
	}
}
export async function mediaURLs(
	projectId: string,
	media: Media[],
	existing: Map<string, string>,
) {
	for (const m of media) {
		if (existing.has(m.id)) continue;
		const blob = await readStore<Blob>("media", `${projectId}:${m.id}`);
		if (blob) existing.set(m.id, URL.createObjectURL(blob));
	}
	return existing;
}
