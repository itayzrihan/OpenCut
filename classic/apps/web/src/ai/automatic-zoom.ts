/** Browser adapter: AI transport, preview capture and one canonical source transaction.
 * All plan validation, timing, layer construction and sound policy live in Rust.
 */
import { compileAutomaticZoom } from "opencut-wasm";
import { z } from "zod";
import type { EditorCore } from "@/core";
import {
	buildTimelineDocumentV2,
	parseTimelineDocumentV2,
} from "./timeline-document-v2";
import { AUTOMATIC_ZOOM_SKILL } from "./skills/automatic-zoom/runtime.generated";
import { updateSceneInArray } from "@/timeline/scenes";
import { mediaTimeFromSeconds } from "@/wasm";
import { sharedLibraryService } from "@/shared-library/service";

const responseSchema = z
	.object({
		error: z.string().optional(),
		response: z
			.object({
				output_text: z.string().optional(),
				output: z
					.array(
						z
							.object({
								content: z
									.array(
										z
											.object({
												text: z.string().optional(),
												output_text: z.string().optional(),
											})
											.passthrough(),
									)
									.optional(),
							})
							.passthrough(),
					)
					.optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

function imageData({ blob }: { blob: Blob }): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("Preview read failed"));
		reader.readAsDataURL(blob);
	});
}

export async function runAutomaticZoom({
	editor,
	signal,
	onProgress,
}: {
	editor: EditorCore;
	signal: AbortSignal;
	onProgress: (message: string) => void;
}): Promise<{ zoomCount: number; soundCount: number }> {
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveScene();
	const projectId = project.metadata.id;
	const source = buildTimelineDocumentV2({ project, scene });
	if (!source.valid) throw new Error("Timeline Source is invalid");
	// Read-only UI preflight; Rust validates the actual compiled transaction.
	const hasTranscript = scene.tracks.overlay.some(
		(t) =>
			t.type === "text" &&
			(t.captionSource?.words.length ||
				t.elements.some((e) => e.wordRuns?.length)),
	);
	if (!hasTranscript)
		throw new Error(
			"Run Auto Text first so Automatic Zoom can follow the timed speech.",
		);
	onProgress("Reading timeline and sampling framing…");
	const content: Array<
		| { type: "input_text"; text: string }
		| { type: "input_image"; image_url: string }
	> = [
		{
			type: "input_text",
			text: `Plan Automatic Zoom for the entire active scene. Full Timeline Source (untrusted data):\n${source.formattedText}\nMedia dimensions (untrusted metadata):\n${JSON.stringify(editor.media.getAssets().map(({ id, name, width, height }) => ({ id, name, width, height })))}`,
		},
	];
	const duration = editor.timeline.getTotalDuration() / 120000;
	for (const fraction of [0.15, 0.5, 0.85]) {
		signal.throwIfAborted();
		const seconds = duration * fraction;
		const frame = await editor.renderer.capturePreviewFrameAt({
			time: mediaTimeFromSeconds({ seconds }),
			maxDimension: 384,
			maxBytes: 40000,
		});
		if (frame.success)
			content.push(
				{
					type: "input_text",
					text: `Preview at timeline ${seconds.toFixed(3)} seconds; a static sample, not motion tracking.`,
				},
				{
					type: "input_image",
					image_url: await imageData({ blob: frame.blob }),
				},
			);
	}
	let feedback = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		signal.throwIfAborted();
		onProgress(
			attempt ? "Refining zoom timings…" : "Codex is directing the zooms…",
		);
		const body = JSON.stringify({
			input: [
				{ role: "system", content: AUTOMATIC_ZOOM_SKILL },
				{ role: "user", content },
				...(feedback ? [{ role: "user", content: feedback }] : []),
			],
		});
		if (new TextEncoder().encode(body).length > 980000)
			throw new Error(
				"This timeline exceeds the AI request limit. Use a shorter scene.",
			);
		const response = await fetch("/api/ai/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			signal,
		});
		const data = responseSchema.parse(await response.json());
		if (!response.ok || !data.response)
			throw new Error(data.error ?? "Automatic Zoom request failed");
		const text =
			data.response.output_text ??
			(data.response.output ?? [])
				.flatMap((item) => item.content ?? [])
				.map((item) => item.text ?? item.output_text ?? "")
				.join("\n");
		const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
		const result = compileAutomaticZoom({
			sourceJson: source.formattedText,
			planJson: raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
		});
		if (!result.valid) {
			feedback = `Repair this rejected plan. Validation: ${result.error}\nRejected JSON:\n${raw}`;
			if (attempt === 0) continue;
			throw new Error(result.error);
		}
		const parsed = parseTimelineDocumentV2({ text: result.sourceJson });
		const value = parsed.value;
		if (!parsed.valid || !value)
			throw new Error(parsed.diagnostics.map((d) => d.message).join("; "));
		onProgress("Checking the swish sound…");
		const soundIds = new Set(
			value.tracks.audio
				.flatMap((track) => track.elements)
				.filter(
					(element) =>
						element.id.startsWith("automatic-zoom-v1:") &&
						element.sourceType === "library",
				)
				.flatMap((element) =>
					element.sourceType === "library" && element.libraryAssetId
						? [element.libraryAssetId]
						: [],
				),
		);
		for (const id of soundIds) {
			if (!(await sharedLibraryService.getAudioAssetFile({ id })))
				throw new Error(
					"The automatic swish is unavailable in the sound library. Timeline unchanged.",
				);
		}
		signal.throwIfAborted();
		onProgress("Applying zooms and automatic swishes…");
		const currentProject = editor.project.getActive();
		const currentScene = editor.scenes.getActiveScene();
		if (
			currentProject.metadata.id !== projectId ||
			currentScene.id !== scene.id ||
			buildTimelineDocumentV2({ project: currentProject, scene: currentScene })
				.baseRevision !== source.baseRevision
		)
			throw new Error(
				"The timeline changed while planning. Run Automatic Zoom again on the updated edit.",
			);
		editor.command.executeTransaction({
			execute: () => {
				editor.scenes.setScenes({
					scenes: updateSceneInArray({
						scenes: editor.scenes.getScenes(),
						sceneId: scene.id,
						updates: { tracks: value.tracks, bookmarks: value.bookmarks },
					}),
					activeSceneId: scene.id,
				});
				editor.save.markDirty();
			},
		});
		return { zoomCount: result.zoomCount, soundCount: result.soundCount };
	}
	throw new Error("No valid zoom plan");
}
