/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Synthetic browser host with real decoder/canvas. */
import type { EditorCore } from "@/core";
import { performProductionVideoInspection } from "./video-inspection";
export async function inspectVideoFixture(
	mode: "success" | "account" | "revision" | "cancel" | "range",
) {
	window.__opencutAccountId = "video-fixture";
	const source = {
		id: "source",
		type: "video",
		file: new File(
			[await (await fetch("/video.webm")).blob()],
			"synthetic.webm",
			{ type: "video/webm" },
		),
	};
	let revision = 7;
	const controller = new AbortController();
	const samples: Array<{
		width: number;
		height: number;
		pixel: number[];
		bytes: number;
	}> = [];
	const stored: Uint8Array[] = [];
	const editor = {
		project: { getActiveOrNull: () => ({ metadata: { id: "project" } }) },
		media: { getAssets: () => [source] },
		command: {
			getCanonicalRevision: () => revision,
			storeEditingAttachment: ({ bytes }: { bytes: Uint8Array }) => {
				stored.push(bytes);
				return { artifactId: `frame-${stored.length}` };
			},
		},
	} as unknown as EditorCore;
	const originalCreate = document.createElement.bind(document);
	document.createElement = ((
		...args: Parameters<typeof document.createElement>
	) => {
		const element = originalCreate(...args);
		if (args[0] === "video")
			element.addEventListener(
				"loadeddata",
				() => {
					if (mode === "account") window.__opencutAccountId = "other";
					if (mode === "revision") revision++;
					if (mode === "cancel") controller.abort();
				},
				{ once: true },
			);
		return element;
	}) as typeof document.createElement;
	try {
		const result = await performProductionVideoInspection({
			editor,
			accountId: "video-fixture",
			signal: controller.signal,
			effect: {
				id: 1,
				adapter: "productionVideoFrames",
				projectId: "project",
				request: {
					projectId: "project",
					expectedRevision: 7,
					mediaId: "source",
					timesMs: mode === "range" ? [9999] : [250, 1250],
				},
			},
		});
		for (const bytes of stored) {
			const image = await createImageBitmap(
				new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
			);
			const canvas = originalCreate("canvas");
			canvas.width = image.width;
			canvas.height = image.height;
			const context = canvas.getContext("2d")!;
			context.drawImage(image, 0, 0);
			samples.push({
				width: image.width,
				height: image.height,
				bytes: bytes.byteLength,
				pixel: Array.from(context.getImageData(10, 10, 1, 1).data),
			});
			image.close();
		}
		return { result, samples, stored: stored.length };
	} finally {
		document.createElement = originalCreate;
	}
}
