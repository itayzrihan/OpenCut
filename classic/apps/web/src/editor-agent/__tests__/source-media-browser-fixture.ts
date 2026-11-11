/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Fake scoped editor, real Chromium media decoder. */
import type { EditorCore } from "@/core";
import { TimelineDragSource } from "@/timeline/drag-source";
import {
	draggedProjectMedia,
	projectMediaAttachment,
	readProjectMediaReference,
} from "../project-media-attachments";
import { performProjectMediaObservation } from "../source-media-observation";

function waveFile() {
	const rate = 16000,
		samples = rate * 2;
	const data = new DataView(new ArrayBuffer(44 + 2 * samples));
	const fourcc = (offset: number, value: string) =>
		Array.from(value).forEach((c, i) =>
			data.setUint8(offset + i, c.charCodeAt(0)),
		);
	fourcc(0, "RIFF");
	data.setUint32(4, data.byteLength - 8, true);
	fourcc(8, "WAVE");
	fourcc(12, "fmt ");
	data.setUint32(16, 16, true);
	data.setUint16(20, 1, true);
	data.setUint16(22, 1, true);
	data.setUint32(24, rate, true);
	data.setUint32(28, rate * 2, true);
	data.setUint16(32, 2, true);
	data.setUint16(34, 16, true);
	fourcc(36, "data");
	data.setUint32(40, samples * 2, true);
	for (let i = 0; i < samples; i++)
		data.setInt16(
			44 + 2 * i,
			i < rate
				? 0
				: Math.round(16383 * Math.sin((i * 2 * Math.PI * 440) / rate)),
			true,
		);
	return new File([data.buffer], "source.wav", { type: "audio/wav" });
}

export async function observeDroppedMedia() {
	window.__opencutAccountId = "fixture";
	const canvas = document.createElement("canvas");
	canvas.width = 1200;
	canvas.height = 600;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "#00dd00";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	const png = await new Promise<Blob>((resolve, reject) =>
		canvas.toBlob((blob) =>
			blob ? resolve(blob) : reject(new Error("Fixture PNG failed")),
		),
	);
	const assets = [
		{
			id: "photo",
			name: "Photo",
			type: "image",
			file: new File([png], "photo.png", { type: "image/png" }),
		},
		{ id: "sound", name: "Sound", type: "audio", file: waveFile() },
	] as const;
	const stored: Uint8Array[] = [];
	const editor = {
		project: { getActiveOrNull: () => ({ metadata: { id: "project" } }) },
		media: { getAssets: () => assets },
		command: {
			getCanonicalRevision: () => 7,
			storeEditingAttachment: ({ bytes }: { bytes: Uint8Array }) => {
				stored.push(bytes);
				return { artifactId: "decoded-image" };
			},
		},
	} as unknown as EditorCore;
	const dragSource = new TimelineDragSource();
	const transfer = new DataTransfer();
	dragSource.begin({
		dataTransfer: transfer,
		dragData: { type: "media", id: "photo", name: "Photo", mediaType: "image" },
	});
	const dropId = draggedProjectMedia({
		types: transfer.types,
		active: dragSource.getActive(),
	});
	const forgedId = draggedProjectMedia({ types: transfer.types, active: null });
	const reference = readProjectMediaReference(
		projectMediaAttachment({ projectId: "project", asset: assets[0] }),
	);
	const request = (
		mediaId: string,
		observation: unknown,
		expectedRevision = 7,
		accountId = "fixture",
	) =>
		performProjectMediaObservation({
			editor,
			accountId,
			signal: new AbortController().signal,
			effect: {
				id: 1,
				adapter: "projectMediaObservation",
				projectId: "project",
				request: {
					projectId: "project",
					mediaId,
					expectedRevision,
					observation,
				},
			},
		});
	const image = await request(dropId!, { mode: "image" });
	const stale = await request("photo", { mode: "image" }, 6);
	const foreign = await request("photo", { mode: "image" }, 7, "foreign");
	const silence = await request("sound", {
		mode: "audio",
		startMs: 100,
		endMs: 700,
		transcribe: false,
	});
	const tone = await request("sound", {
		mode: "audio",
		startMs: 1200,
		endMs: 2100,
		transcribe: true,
	});
	const bmp = await createImageBitmap(
		new Blob([new Uint8Array(stored[0]!)], { type: "image/jpeg" }),
	);
	canvas.width = bmp.width;
	canvas.height = bmp.height;
	ctx.drawImage(bmp, 0, 0);
	const pixel = Array.from(ctx.getImageData(100, 100, 1, 1).data);
	const preview = {
		width: bmp.width,
		height: bmp.height,
		pixel,
		stored: stored.length,
	};
	bmp.close();
	return { reference, forgedId, image, stale, foreign, silence, tone, preview };
}
