import { toast } from "sonner";
import { getMediaTypeFromFile } from "@/media/media-utils";
import type { MediaAsset } from "@/media/types";
import type { LocalDriveMediaRecord } from "@/services/local-drive/types";
import { localDriveRequest } from "@/services/local-drive/client";
import { mediaStorageDisposition } from "opencut-wasm";
import { readVideoFile } from "./mediabunny";
import type { VideoFileData } from "./mediabunny";
import { renderThumbnailDataUrl } from "./thumbnail";

export type ProcessedMediaAsset = Omit<MediaAsset, "id"> & { id?: string };

const getUnsupportedVideoDescription = ({
	codec,
}: {
	codec: VideoFileData["codec"];
}): string => {
	const codecLabel = codec ? codec.toUpperCase() : "this video codec";

	return codec === "hevc"
		? `${codecLabel} cannot be decoded in this browser, so this clip may not preview correctly. Convert it to H.264 MP4 or try importing it in Safari.`
		: `${codecLabel} cannot be decoded in this browser, so this clip may not preview correctly. Convert it to H.264 MP4 and reimport it.`;
};

async function generateImageThumbnail({
	url,
	revokeUrl,
}: {
	url: string;
	revokeUrl: boolean;
}): Promise<{ thumbnailUrl: string; width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const image = new window.Image();

		image.addEventListener("load", () => {
			try {
				const thumbnailUrl = renderThumbnailDataUrl({
					width: image.naturalWidth,
					height: image.naturalHeight,
					draw: ({ context, width, height }) => {
						context.drawImage(image, 0, 0, width, height);
					},
				});
				resolve({
					thumbnailUrl,
					width: image.naturalWidth,
					height: image.naturalHeight,
				});
			} catch (error) {
				reject(
					error instanceof Error ? error : new Error("Could not render image"),
				);
			} finally {
				if (revokeUrl) URL.revokeObjectURL(url);
				image.remove();
			}
		});

		image.addEventListener("error", () => {
			if (revokeUrl) URL.revokeObjectURL(url);
			image.remove();
			reject(new Error("Could not load image"));
		});

		image.src = url;
	});
}

export async function processMediaAssets({
	files,
	onProgress,
}: {
	files: FileList | File[];
	onProgress?: ({ progress }: { progress: number }) => void;
}): Promise<ProcessedMediaAsset[]> {
	const fileArray = Array.from(files);
	const processedAssets: ProcessedMediaAsset[] = [];

	const total = fileArray.length;
	let completed = 0;

	for (const file of fileArray) {
		const fileType = getMediaTypeFromFile({ file });

		if (!fileType) {
			toast.error(`Unsupported file type: ${file.name}`);
			continue;
		}

		if (
			mediaStorageDisposition({
				size: file.size,
				hasSourcePath: false,
				preserveLink: false,
			}) === "sourcePathRequired"
		) {
			toast.error(`Use the drive picker for ${file.name}`, {
				description:
					"Files larger than 1 GB are linked to their original path. Use the Import button so PoCut can retain that path.",
			});
			continue;
		}

		const url = URL.createObjectURL(file);
		let thumbnailUrl: string | undefined;
		let duration: number | undefined;
		let width: number | undefined;
		let height: number | undefined;
		let fps: number | undefined;
		let hasAudio: boolean | undefined;

		try {
			if (fileType === "image") {
				const result = await generateImageThumbnail({
					url: URL.createObjectURL(file),
					revokeUrl: true,
				});
				thumbnailUrl = result.thumbnailUrl;
				width = result.width;
				height = result.height;
			} else if (fileType === "video") {
				try {
					const videoData = await readVideoFile({ file });
					duration = videoData.duration;
					width = videoData.width;
					height = videoData.height;
					fps = Number.isFinite(videoData.fps)
						? Math.round(videoData.fps)
						: undefined;
					hasAudio = videoData.hasAudio;
					thumbnailUrl = videoData.thumbnailUrl ?? undefined;

					if (!videoData.canDecode) {
						toast.error(`Can't preview ${file.name}`, {
							description: getUnsupportedVideoDescription({
								codec: videoData.codec,
							}),
						});
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Could not process video";

					toast.error(`Couldn't process ${file.name}`, {
						description: message,
					});
				}
			} else if (fileType === "audio") {
				duration = await getMediaDuration({ file });
			}

			processedAssets.push({
				name: file.name,
				type: fileType,
				file,
				url,
				size: file.size,
				lastModified: file.lastModified,
				fileName: file.name,
				mimeType: file.type,
				thumbnailUrl,
				duration,
				width,
				height,
				fps,
				hasAudio,
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			completed += 1;
			if (onProgress) {
				const percent = Math.round((completed / total) * 100);
				onProgress({ progress: percent });
			}
		} catch (error) {
			console.error("Error processing file:", file.name, error);
			toast.error(`Failed to process ${file.name}`);
			URL.revokeObjectURL(url);
		}
	}

	return processedAssets;
}

export async function processLocalDriveMedia({
	projectId,
	records,
	onProgress,
}: {
	projectId: string;
	records: LocalDriveMediaRecord[];
	onProgress?: ({ progress }: { progress: number }) => void;
}): Promise<ProcessedMediaAsset[]> {
	const processed: ProcessedMediaAsset[] = [];
	let completed = 0;
	for (const record of records) {
		const url = `/api/local-drive/media?${new URLSearchParams({
			projectId,
			id: record.id,
		})}`;
		try {
			let thumbnailUrl = record.thumbnailUrl;
			let duration = record.duration;
			let width = record.width;
			let height = record.height;
			let fps = record.fps;
			let hasAudio = record.hasAudio;
			if (record.type === "image") {
				const image = await generateImageThumbnail({ url, revokeUrl: false });
				thumbnailUrl = image.thumbnailUrl;
				width = image.width;
				height = image.height;
			} else if (record.type === "video") {
				const video = await readVideoFile({ url });
				duration = video.duration;
				width = video.width;
				height = video.height;
				fps = Number.isFinite(video.fps) ? Math.round(video.fps) : undefined;
				hasAudio = video.hasAudio;
				thumbnailUrl = video.thumbnailUrl ?? undefined;
				if (!video.canDecode) {
					toast.error(`Can't preview ${record.name}`, {
						description: getUnsupportedVideoDescription({ codec: video.codec }),
					});
				}
			} else {
				duration = await getMediaDuration({ url, mimeType: record.mimeType });
			}
			processed.push({
				...record,
				url,
				thumbnailUrl,
				duration,
				width,
				height,
				fps,
				hasAudio,
			});
		} catch (error) {
			console.error("Error processing drive media:", record.name, error);
			toast.error(`Failed to process ${record.name}`);
			await localDriveRequest({
				operation: "media.delete",
				payload: { projectId, id: record.id },
			}).catch(() => undefined);
		}
		completed += 1;
		onProgress?.({
			progress: Math.round((completed / Math.max(1, records.length)) * 100),
		});
	}
	return processed;
}

const getMediaDuration = ({
	file,
	url,
	mimeType,
}: {
	file?: File;
	url?: string;
	mimeType?: string;
}): Promise<number> => {
	return new Promise((resolve, reject) => {
		const element = document.createElement(
			(file?.type ?? mimeType ?? "").startsWith("video/") ? "video" : "audio",
		) as HTMLVideoElement;
		const objectUrl = file ? URL.createObjectURL(file) : null;
		const sourceUrl = objectUrl ?? url;
		if (!sourceUrl) {
			reject(new Error("Media URL is missing"));
			return;
		}

		element.addEventListener("loadedmetadata", () => {
			resolve(element.duration);
			if (objectUrl) URL.revokeObjectURL(objectUrl);
			element.remove();
		});

		element.addEventListener("error", () => {
			reject(new Error("Could not load media"));
			if (objectUrl) URL.revokeObjectURL(objectUrl);
			element.remove();
		});

		element.src = sourceUrl;
		element.load();
	});
};
