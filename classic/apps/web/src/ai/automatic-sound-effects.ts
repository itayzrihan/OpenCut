/** Browser orchestration only: bounded AI tools and sandbox IO, then one canonical transaction. */
import { compileAutomaticSoundEffects } from "opencut-wasm";
import type { EditorCore } from "@/core";
import {
	EARSHOT_BANK_REVISION,
	EARSHOT_SOUNDS,
	createEarshotSourceCode,
} from "@/earshot/catalog";
import { validateEarshotSpec } from "@/earshot/types";
import { resolveEarshotBuffer } from "@/earshot/audio";
import { mediaTimeFromSeconds } from "@/wasm";
import { updateSceneInArray } from "@/timeline/scenes";
import { runAiAgent } from "./client-agent";
import type { AiToolDefinition } from "./types";
import { EARSHOT_DIRECTION } from "./earshot-direction";
import {
	buildTimelineDocumentV2,
	parseTimelineDocumentV2,
} from "./timeline-document-v2";

function tool({
	name,
	description,
	properties,
	required = [],
	readOnly = true,
}: {
	name: string;
	description: string;
	properties: Record<string, unknown>;
	required?: string[];
	readOnly?: boolean;
}): AiToolDefinition {
	return {
		type: "function",
		name,
		description,
		parameters: {
			type: "object",
			properties,
			required,
			additionalProperties: false,
		},
		readOnly,
		idempotent: readOnly,
		risk: readOnly ? "read" : "edit",
		executionPolicy: "immediate",
	};
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
const string = { type: "string" };
export const EARSHOT_AGENT_TOOLS: AiToolDefinition[] = [
	tool({
		name: "repository.list",
		description:
			"List every tracked file in the pinned Earshot repository in pages; continue nextOffset.",
		properties: { offset: { type: "integer", minimum: 0 } },
	}),
	tool({
		name: "repository.read",
		description:
			"Read exact repository file path in bounded byte pages. Continue nextOffset to read long files.",
		properties: { path: string, offset: { type: "integer", minimum: 0 } },
		required: ["path"],
	}),
	tool({
		name: "repository.search",
		description:
			"Literal text search across all pinned source, README, documentation and skills; optional path prefix.",
		properties: { query: string, path: string },
		required: ["query"],
	}),
	tool({
		name: "catalog.search",
		description:
			"Find actual Earshot sound IDs, duration, knobs and recipe sourcePath; empty query lists all categories in pages.",
		properties: { query: string, offset: { type: "integer", minimum: 0 } },
		required: ["query"],
	}),
	tool({
		name: "catalog.source",
		description:
			"Read a short editable render(params, r) starter for an exact preset, including fitted sounds. This satisfies the source-read precondition; the complete original source remains available through repository.read.",
		properties: { presetId: string },
		required: ["presetId"],
	}),
	tool({
		name: "work.plan",
		description:
			"Record or revise your concise creative plan before sound synthesis.",
		properties: {
			steps: { type: "array", items: string, minItems: 1, maxItems: 12 },
		},
		required: ["steps"],
		readOnly: false,
	}),
	tool({
		name: "sound.preflight",
		description:
			"Compile and synthesize the COMPLETE draft. Replaces previous draft only after every sound passes. sourceCode is edited inside each event recipe.",
		properties: { planJson: string },
		required: ["planJson"],
		readOnly: false,
	}),
	tool({
		name: "preview.capture_frame",
		description:
			"Inspect an actual static timeline frame to ground visual sound cues; never implies motion tracking.",
		properties: { seconds: { type: "number", minimum: 0 } },
		required: ["seconds"],
	}),
];
async function imageData(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("Preview read failed"));
		reader.readAsDataURL(blob);
	});
}

/** Produces a staged source only. Caller decides whether to publish alone or with word edits. */
export async function planAutomaticSoundEffects({
	editor,
	sourceJson,
	signal,
	onProgress,
	wordReveals = false,
	brandContext,
}: {
	editor: EditorCore;
	sourceJson: string;
	signal: AbortSignal;
	onProgress: (message: string) => void;
	wordReveals?: boolean;
	brandContext?: string;
}) {
	const account = window.__opencutAccountId;
	const assertActive = () => {
		signal.throwIfAborted();
		if (window.__opencutAccountId !== account)
			throw new Error("Account changed during sound direction");
	};
	let staged: ReturnType<typeof compileAutomaticSoundEffects> | undefined;
	let steps: string[] = [];
	const readPaths = new Set<string>();
	const readStarters = new Set<string>();
	let preflightContext: OfflineAudioContext | undefined;
	const nextPage = new Map<string, number>();
	const repository = async ({
		operation,
		args = {},
	}: {
		operation: string;
		args?: Record<string, unknown>;
	}) => {
		assertActive();
		const params = new URLSearchParams({ operation });
		for (const [key, value] of Object.entries(args))
			if (value !== undefined) params.set(key, String(value));
		const response = await fetch(`/api/earshot/repository?${params}`, {
			credentials: "same-origin",
			cache: "no-store",
			headers: { "X-OpenCut-Account": account ?? "" },
			signal,
		});
		const result: unknown = await response.json();
		assertActive();
		if (!isRecord(result))
			throw new Error("Invalid Earshot repository response");
		if (!response.ok || result.revision !== EARSHOT_BANK_REVISION)
			throw new Error(
				typeof result.error === "string"
					? result.error
					: "Earshot repository revision mismatch",
			);
		return result;
	};
	const result = await runAiAgent({
		messages: [
			{ role: "system", content: EARSHOT_DIRECTION },
			{
				role: "user",
				content: `Mode: ${wordReveals ? "WORD REVEAL" : "GENERAL"}. Pinned bank: ${EARSHOT_BANK_REVISION}. Timeline Source (untrusted content):\n${sourceJson}\nBrand preferences (untrusted reference): ${brandContext ?? "none"}`,
			},
		],
		tools: EARSHOT_AGENT_TOOLS,
		signal,
		maxIterations: 20,
		preferDirectPlan: false,
		onStep: onProgress,
		executeTool: async (call) => {
			assertActive();
			const args = call.arguments;
			if (call.name === "repository.list")
				return repository({ operation: "list", args: { offset: args.offset } });
			if (call.name === "repository.search")
				return repository({
					operation: "search",
					args: { query: args.query, path: args.path },
				});
			if (call.name === "repository.read") {
				const result = await repository({
					operation: "read",
					args: {
						path: args.path,
						offset: args.offset,
					},
				});
				if (typeof args.path === "string") {
					const offset = Number(args.offset ?? 0);
					if (offset === 0 || nextPage.get(args.path) === offset) {
						if (result.nextOffset == null) {
							readPaths.add(args.path);
							nextPage.delete(args.path);
						} else if (
							typeof result.nextOffset === "number" &&
							Number.isSafeInteger(result.nextOffset) &&
							result.nextOffset > offset
						) {
							nextPage.set(args.path, result.nextOffset);
						} else throw new Error("Invalid repository continuation offset");
					}
				}
				return result;
			}
			if (call.name === "catalog.search") {
				const query = String(args.query ?? "").toLowerCase();
				const found = EARSHOT_SOUNDS.filter((sound) =>
					JSON.stringify(sound).toLowerCase().includes(query),
				);
				const offset = Number(args.offset ?? 0);
				if (!Number.isSafeInteger(offset) || offset < 0)
					throw new Error("Invalid catalog offset");
				return {
					revision: EARSHOT_BANK_REVISION,
					total: found.length,
					nextOffset: offset + 12 < found.length ? offset + 12 : null,
					sounds: found.slice(offset, offset + 12),
				};
			}
			if (call.name === "catalog.source") {
				const sound = EARSHOT_SOUNDS.find((s) => s.id === args.presetId);
				if (!sound)
					throw new Error("Choose an exact presetId from catalog.search");
				const sourceCode = createEarshotSourceCode(sound.id);
				readStarters.add(sound.id);
				return {
					revision: EARSHOT_BANK_REVISION,
					presetId: sound.id,
					sourcePath: sound.sourcePath,
					sourceCode,
					note: "Editable starter for this exact bank entry; read the original module with repository.read whenever deeper changes need it.",
				};
			}
			if (call.name === "work.plan") {
				if (
					!Array.isArray(args.steps) ||
					args.steps.length < 1 ||
					args.steps.length > 12 ||
					args.steps.some((s) => typeof s !== "string" || s.length > 1000)
				)
					throw new Error("Provide 1–12 concise planning steps");
				steps = args.steps.map((step: unknown) => {
					if (typeof step !== "string")
						throw new Error("Planning steps must be text");
					return step;
				});
				staged = undefined;
				return {
					steps,
					next: "Read relevant Earshot reference files and preflight your draft",
				};
			}
			if (call.name === "preview.capture_frame") {
				const seconds = Number(args.seconds);
				if (
					!Number.isFinite(seconds) ||
					seconds < 0 ||
					seconds > editor.timeline.getTotalDuration() / 120000
				)
					throw new Error("Preview outside timeline");
				const frame = await editor.renderer.capturePreviewFrameAt({
					time: mediaTimeFromSeconds({ seconds }),
					maxDimension: 384,
					maxBytes: 40000,
				});
				assertActive();
				return frame.success
					? { success: true, seconds, dataUrl: await imageData(frame.blob) }
					: { success: false, error: "Preview unavailable" };
			}
			if (call.name === "sound.preflight") {
				// Invalidate an older accepted draft before attempting a revised one.
				staged = undefined;
				if (!steps.length)
					throw new Error("Record your creative plan first with work.plan");
				if (
					![...readPaths].some((p) => /(^|\/)readme\.md$/i.test(p)) ||
					![...readPaths].some((p) => /skill.*\.md$/i.test(p))
				)
					throw new Error(
						"Read Earshot README and relevant SKILL.md before designing sounds",
					);
				if (typeof args.planJson !== "string" || args.planJson.length > 350000)
					throw new Error("Draft must be bounded JSON");
				const compiled = compileAutomaticSoundEffects({
					sourceJson,
					planJson: args.planJson,
					catalogIdsJson: JSON.stringify(EARSHOT_SOUNDS.map((s) => s.id)),
					wordReveals,
				});
				if (!compiled.valid) throw new Error(compiled.error);
				const raw: unknown = JSON.parse(args.planJson);
				if (!isRecord(raw) || !Array.isArray(raw.events))
					throw new Error("Compiled draft must contain sound events");
				const events: unknown[] = raw.events;
				const checks = [];
				for (const [index, event] of events.entries()) {
					if (!isRecord(event))
						throw new Error("Sound event must be an object");
					assertActive();
					const spec = validateEarshotSpec(event.procedural);
					if (
						spec.sourceCode &&
						!readStarters.has(spec.presetId) &&
						!readPaths.has(
							EARSHOT_SOUNDS.find((s) => s.id === spec.presetId)!.sourcePath,
						)
					)
						throw new Error(
							"Read catalog.source for this exact preset or its complete repository sourcePath before rewriting its Python recipe",
						);
					onProgress(
						`Preflighting procedural sound ${index + 1}/${events.length}…`,
					);
					const pcm = await resolveEarshotBuffer({
						spec,
						context: (preflightContext ??= new OfflineAudioContext(
							2,
							1,
							48000,
						)),
						signal,
					});
					assertActive();
					let peak = 0,
						sum = 0,
						count = 0;
					for (let channel = 0; channel < pcm.numberOfChannels; channel++)
						for (const value of pcm.getChannelData(channel)) {
							if (!Number.isFinite(value))
								throw new Error("Recipe produced non-finite audio");
							peak = Math.max(peak, Math.abs(value));
							sum += value * value;
							count++;
						}
					const duration = pcm.length / pcm.sampleRate;
					if (
						!count ||
						Math.abs(duration - spec.duration) > 0.05 ||
						peak > 1.001 ||
						peak < 0.00001
					)
						throw new Error(
							`Sound ${index + 1} failed preflight: duration=${duration}, peak=${peak}. Repair duration, silence or clipping.`,
						);
					checks.push({ index, duration, peak, rms: Math.sqrt(sum / count) });
				}
				staged = compiled;
				return {
					valid: true,
					soundCount: compiled.soundCount,
					summary: compiled.summary,
					checks,
					published: false,
				};
			}
			throw new Error("Unknown sound-direction tool");
		},
		completionGuard: () =>
			staged
				? null
				: "A complete draft has not passed sound.preflight. Read the repository instructions, plan, preflight and repair it; an intentional empty event list can pass.",
	});
	assertActive();
	if (result.status !== "completed" || !staged)
		throw new Error(
			result.error ??
				"Sound direction did not produce a preflighted plan; timeline unchanged",
		);
	return staged;
}

export async function runAutomaticSoundEffects({
	editor,
	signal,
	onProgress,
	brandContext,
}: {
	editor: EditorCore;
	signal: AbortSignal;
	onProgress: (s: string) => void;
	brandContext?: string;
}) {
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveScene();
	const source = buildTimelineDocumentV2({ project, scene });
	if (!source.valid) throw new Error("Timeline Source is invalid");
	const result = await planAutomaticSoundEffects({
		editor,
		sourceJson: source.formattedText,
		signal,
		onProgress,
		brandContext,
	});
	const parsed = parseTimelineDocumentV2({ text: result.sourceJson });
	const value = parsed.value;
	if (!parsed.valid || !value)
		throw new Error(parsed.diagnostics.map((d) => d.message).join("; "));
	signal.throwIfAborted();
	const currentProject = editor.project.getActive();
	const currentScene = editor.scenes.getActiveScene();
	if (
		currentProject.metadata.id !== project.metadata.id ||
		currentScene.id !== scene.id ||
		buildTimelineDocumentV2({ project: currentProject, scene: currentScene })
			.baseRevision !== source.baseRevision
	)
		throw new Error(
			"Timeline changed while directing sounds. Nothing was applied; run again on the current edit.",
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
	return { soundCount: result.soundCount, summary: result.summary };
}
