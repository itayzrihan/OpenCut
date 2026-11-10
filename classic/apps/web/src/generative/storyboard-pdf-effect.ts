import type { EditorCore } from "@/core";
import type {
	EditingAgentHostEffect,
	EditingAgentHostResult,
} from "@/core/agent-protocol";
import { loadBundledAssistantBold } from "@/fonts/bundled-fonts";
import { z } from "zod";
import { fileUrl } from "./client";
import {
	parseStoryboardPdfPlan,
	type StoryboardPdfImage,
} from "./storyboard-pdf-plan";
import {
	PDF_PAGE_HEIGHT,
	PDF_PAGE_WIDTH,
	renderStoryboardPdf,
} from "./storyboard-pdf-render";
export interface StoryboardPdfDownload {
	blob: Blob;
	filename: string;
	artifactId: string;
}

function waitForFont({ signal }: { signal: AbortSignal }): Promise<string> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Storyboard export cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		loadBundledAssistantBold()
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}
async function imageBlob({
	response,
	signal,
}: {
	response: Response;
	signal: AbortSignal;
}): Promise<Blob> {
	const max = 16 * 1024 * 1024;
	if (!response.ok || !response.body)
		throw new Error("Could not download a storyboard image from this project");
	if (Number(response.headers.get("content-length")) > max)
		throw new Error("A storyboard image exceeds 16 MiB");
	const reader = response.body.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let length = 0;
	try {
		for (;;) {
			signal.throwIfAborted();
			const { value, done } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > max) throw new Error("A storyboard image exceeds 16 MiB");
			chunks.push(new Uint8Array(value));
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	return new Blob(chunks, {
		type: response.headers.get("content-type")?.split(";")[0] ?? "",
	});
}
/** Local CPU/browser rendering only. The host fetches existing owned images;
 * it cannot submit AI generation, accept arbitrary URLs or mutate project state. */
export async function performStoryboardPdfEffect({
	effect,
	editor,
	accountId,
	signal,
	onExport = () => {},
	retainForConversation = false,
}: {
	effect: EditingAgentHostEffect;
	editor: EditorCore;
	accountId: string;
	signal: AbortSignal;
	onExport?: (value: StoryboardPdfDownload) => void;
	retainForConversation?: boolean;
}): Promise<EditingAgentHostResult> {
	try {
		const envelope = z
			.object({ plan: z.unknown() })
			.strict()
			.parse(effect.request);
		const plan = parseStoryboardPdfPlan(envelope.plan);
		const check = () => {
			signal.throwIfAborted();
			if (
				effect.adapter !== "storyboardPdf" ||
				plan.projectId !== effect.projectId ||
				(window.__opencutAccountId ?? "local") !== accountId ||
				editor.project.getActiveOrNull()?.metadata.id !== plan.projectId ||
				editor.command.getCanonicalRevision() !== plan.revision
			)
				throw new Error("The storyboard account, project or revision changed");
		};
		check();
		const fontFamily = await waitForFont({ signal });
		check();
		const loadImage = async (reference: StoryboardPdfImage) => {
			check();
			const response = await fetch(
				fileUrl({ projectId: plan.projectId, id: reference.id }),
				{
					credentials: "same-origin",
					cache: "no-store",
					signal,
					headers: { "X-OpenCut-Account": accountId },
				},
			);
			const blob = await imageBlob({
				response: response,
				signal: signal,
			});
			check();
			if (blob.type !== reference.mime)
				throw new Error("The storyboard image type changed");
			const bitmap = await createImageBitmap(blob);
			try {
				check();
			} catch (error) {
				bitmap.close();
				throw error;
			}
			return {
				source: bitmap,
				width: bitmap.width,
				height: bitmap.height,
				close: () => bitmap.close(),
			};
		};
		const rendered = await renderStoryboardPdf({
			plan,
			signal,
			fontFamily,
			loadImage,
			createCanvas: () => {
				check();
				const canvas = document.createElement("canvas");
				canvas.width = PDF_PAGE_WIDTH;
				canvas.height = PDF_PAGE_HEIGHT;
				return canvas;
			},
			onProgress: check,
		});
		check();
		const artifact = editor.command.storeCanonicalStoryboardPdf({
			projectId: plan.projectId,
			accountId,
			bytes: rendered.bytes,
			retainForConversation,
		});
		const blob = new Blob([new Uint8Array(rendered.bytes)], {
			type: "application/pdf",
		});
		const filename = `${
			plan.title
				.replace(/[<>:"/\\|?*]/g, "-")
				.split("")
				.map((character) => (character.charCodeAt(0) < 32 ? "-" : character))
				.join("")
				.slice(0, 100)
				.trim() || "POCUT"
		}-storyboard.pdf`;
		check();
		onExport({ blob, filename, artifactId: artifact.id });
		return {
			type: "success",
			data: {
				projectId: plan.projectId,
				revision: plan.revision,
				planDigest: plan.digest,
				artifact,
				pageCount: rendered.pageCount,
			},
		};
	} catch (error) {
		return {
			type: "rejected",
			message:
				error instanceof Error
					? error.message
					: "Could not export the storyboard PDF",
		};
	}
}
/** The download is released only after Rust validates the completed artifact. */
export async function exportStoryboardPdf({
	editor,
	signal,
}: {
	editor: EditorCore;
	signal: AbortSignal;
}): Promise<void> {
	const projectId = editor.project.getActiveOrNull()?.metadata.id;
	const accountId = window.__opencutAccountId ?? "local";
	const expectedRevision = editor.command.getCanonicalRevision();
	if (!projectId || expectedRevision === undefined)
		throw new Error("Open a project before exporting its storyboard");
	const downloads: StoryboardPdfDownload[] = [];
	const receipt = await editor.command.invokeCanonicalMcp({
		capabilityId: "project.generative.storyboard.export",
		projectId,
		accountId,
		signal,
		input: { projectId, expectedRevision },
		context: {
			dryRun: false,
			requestId: crypto.randomUUID(),
			metadata: { "opencut/projectId": projectId },
		},
		host: (effect) =>
			performStoryboardPdfEffect({
				effect,
				editor,
				accountId,
				signal,
				onExport: (value) => downloads.push(value),
			}),
	});
	signal.throwIfAborted();
	const download = downloads[0];
	if (
		!download ||
		downloads.length !== 1 ||
		!receipt.artifacts.some(
			(a) =>
				a.metadata.id === download.artifactId &&
				a.metadata.mimeType === "application/pdf",
		)
	)
		throw new Error("The canonical editor did not confirm the PDF artifact");
	const url = URL.createObjectURL(download.blob);
	try {
		const link = document.createElement("a");
		link.href = url;
		link.download = download.filename;
		document.body.append(link);
		link.click();
		link.remove();
	} finally {
		setTimeout(() => URL.revokeObjectURL(url), 60000);
	}
}
