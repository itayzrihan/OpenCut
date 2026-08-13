import { z } from "zod";
import type { EditorCore } from "@/core";
import { AddClipEffectCommand, BatchCommand } from "@/commands";
import { InsertElementCommand } from "@/commands/timeline";
import { EDITORIAL_EDGE_FEATHER_EFFECT_TYPE } from "@/effects/definitions/editorial-edge-feather";
import { calculateTotalDuration, getDisplayTracks } from "@/timeline";
import type { SceneTracks, VideoElement } from "@/timeline";
import { buildUiElementBundleTimelineItems } from "@/ui-elements/bundle";
import { UI_ELEMENT_PRESETS } from "@/ui-elements/catalog";
import {
	addMediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export const PAPER_GRID_EDITORIAL_TEMPLATE = {
	id: "paper-grid-editorial",
	name: "Paper Grid Editorial",
	description:
		"Transcript-first talking head edit with a paper-grid speaker breakout, restrained captions, and a precise opening reveal.",
} as const;

const PAPER_GRID_EDITORIAL_EDGE_FEATHER_PARAMS = {
	intensity: 38,
	height: 20,
	softness: 78,
	color: "#000000",
} as const;

export const TEMPLATE_AI_PLAN_SCHEMA = z
	.object({
		placements: z
			.array(
				z
					.object({
						startSeconds: z.number().finite(),
						durationSeconds: z.number().finite(),
					})
					.strict(),
			)
			.min(1)
			.max(3),
		proofStage: z
			.object({
				startSeconds: z.number().finite(),
				endSeconds: z.number().finite(),
			})
			.strict()
			.optional(),
		checklist: z
			.object({
				startSeconds: z.number().finite(),
				eventSeconds: z.number().finite(),
				endSeconds: z.number().finite(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type TemplateAiPlan = z.infer<typeof TEMPLATE_AI_PLAN_SCHEMA>;

export type BreakoutPlacement = z.infer<
	typeof TEMPLATE_AI_PLAN_SCHEMA
>["placements"][number];

export type TemplateVideoTarget = {
	trackId: string;
	element: VideoElement;
};

export function findTemplateVideoTarget({
	tracks,
}: {
	tracks: SceneTracks;
}): TemplateVideoTarget | null {
	return (
		getDisplayTracks({ tracks })
			.flatMap((track) =>
				track.type === "video"
					? track.elements
							.filter((element): element is VideoElement => element.type === "video")
							.map((element) => ({ trackId: track.id, element }))
					: [],
			)
			.sort((left, right) => right.element.duration - left.element.duration)[0] ??
		null
	);
}

export function normalizeBreakoutPlacements({
	placements,
		rangeStartSeconds,
		rangeEndSeconds,
}: {
	placements: BreakoutPlacement[];
	rangeStartSeconds: number;
	rangeEndSeconds: number;
}): BreakoutPlacement[] {
	const start = Number.isFinite(rangeStartSeconds) ? rangeStartSeconds : 0;
	const end = Math.max(start + 1, rangeEndSeconds);
	const normalized: BreakoutPlacement[] = [];
	for (const candidate of placements) {
		const duration = Math.min(8, Math.max(4, candidate.durationSeconds));
		const maxStart = Math.max(start, end - duration);
		const nextStart = Math.min(
			maxStart,
			Math.max(start, candidate.startSeconds),
		);
		if (
			!Number.isFinite(nextStart) ||
			!Number.isFinite(duration) ||
			normalized.some(
				(previous) =>
					nextStart < previous.startSeconds + previous.durationSeconds + 0.2 &&
					previous.startSeconds < nextStart + duration,
			)
		) {
			continue;
		}
		normalized.push({
			startSeconds: Number(nextStart.toFixed(3)),
			durationSeconds: Number(duration.toFixed(3)),
		});
		if (normalized.length === 3) break;
	}
	if (normalized.length > 0) return normalized.sort((a, b) => a.startSeconds - b.startSeconds);

	const fallbackDuration = Math.min(6, Math.max(4, end - start));
	return [
		{
			startSeconds: Number(
				Math.max(start, Math.min(end - fallbackDuration, start + (end - start) * 0.46)).toFixed(3),
			),
			durationSeconds: Number(fallbackDuration.toFixed(3)),
		},
	];
}

export function buildTemplateAiContext({
	tracks,
	target,
	totalDurationSeconds,
}: {
	tracks: SceneTracks;
	target: TemplateVideoTarget;
	totalDurationSeconds: number;
}) {
	const captions = getDisplayTracks({ tracks }).flatMap((track) =>
		track.type === "text"
			? track.elements
					.filter((element) => element.type === "text")
					.map((element) => ({
						startSeconds: Number((element.startTime / 120_000).toFixed(3)),
						endSeconds: Number(
							((element.startTime + element.duration) / 120_000).toFixed(3),
						),
						text: String(element.params.content ?? ""),
					}))
			: [],
	);
	return {
		template: PAPER_GRID_EDITORIAL_TEMPLATE.id,
		skill: {
			name: "paper-grid-editorial",
			reference: "references/hebrew-reference-project-profile.md",
		},
		instruction:
			"Complete only the remaining 5% of a Paper Grid Editorial edit. Choose one, two, or three non-overlapping Speaker Frame Breakout placements, the proof-stage interval where captions should switch to near-black, and checklist timing when the transcript supports it. Do not change cuts, dialogue audio, fonts, or the deterministic opening.",
		referenceGrammar: {
			opening: "human-first 3s monochrome-to-color reveal with glowing divider and whoosh",
			proofStage: "light paper-grid field, speaker in rounded lower frame, black captions",
			checklist: "RTL rows יש לו כסף / קנו אותו / עשו לו; red transition on ביטלתם; stationary blur-zoom-fade exit",
			matte: "apply and reapply the Speaker Frame Breakout matte after timing/source changes",
		},
		videoRange: {
			startSeconds: Number((target.element.startTime / 120_000).toFixed(3)),
			endSeconds: Number(
				((target.element.startTime + target.element.duration) / 120_000).toFixed(3),
			),
			totalDurationSeconds,
		},
		captionHints: captions.slice(0, 120),
	};
}

function findChecklistStartSeconds({ tracks }: { tracks: SceneTracks }): number | null {
	const spokenWords = getDisplayTracks({ tracks }).flatMap((track) => {
		if (track.type !== "text") return [];
		return track.elements.map((element) => ({
			text: String(element.params.content ?? "").trim(),
			startSeconds: mediaTimeToSeconds({ time: element.startTime }),
		}));
	});
	const moneyWord = spokenWords.find(({ text }) => text.includes("כסף"));
	const boughtWord = spokenWords.find(({ text }) => text.includes("קנו"));
	const didWord = spokenWords.find(({ text }) => text.includes("עשו"));
	if (!moneyWord || !boughtWord || !didWord) return null;
	const firstLeadIn = [...spokenWords]
		.reverse()
		.find(({ text, startSeconds }) => text.includes("יש") && startSeconds <= moneyWord.startSeconds);
	return Math.max(0, firstLeadIn?.startSeconds ?? moneyWord.startSeconds - 0.35);
}

export async function chooseTemplateAiPlan({
	context,
	signal,
}: {
	context: ReturnType<typeof buildTemplateAiContext>;
	signal?: AbortSignal;
}): Promise<TemplateAiPlan> {
	const response = await fetch("/api/ai/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			input: [
				{
					role: "system",
						content:
							"You are the 5% completion pass for the OpenCut Paper Grid Editorial template. Follow the paper-grid-editorial skill and the supplied Hebrew reference grammar. Return JSON only with placements (one to three intervals), optional proofStage {startSeconds,endSeconds}, and optional checklist {startSeconds,eventSeconds,endSeconds}. Use only supplied transcript/video timing. Do not invent cuts, assets, or dialogue edits.",
				},
				{ role: "user", content: JSON.stringify(context) },
			],
			tools: [],
		}),
		signal,
	});
	const body = (await response.json().catch(() => ({}))) as {
		error?: string;
		response?: {
			output_text?: string;
			output?: Array<{ content?: Array<{ text?: string; output_text?: string }> }>;
		};
	};
	if (!response.ok) {
		throw new Error(body.error ?? `AI request failed (${response.status})`);
	}
	const text =
		body.response?.output_text ??
		(body.response?.output ?? [])
			.flatMap((item) => item.content ?? [])
			.map((content) => content.text ?? content.output_text ?? "")
			.filter(Boolean)
			.join("\n");
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
	const start = fenced.indexOf("{");
	const end = fenced.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("AI returned no template plan JSON");
	const parsed = TEMPLATE_AI_PLAN_SCHEMA.safeParse(
		JSON.parse(fenced.slice(start, end + 1)),
	);
	if (!parsed.success) throw new Error("AI returned an invalid template completion plan");
	return parsed.data;
}

export function applyProgrammaticEditorialTemplate({
	editor,
}: {
	editor: EditorCore;
}): {
	target: TemplateVideoTarget;
	totalDurationSeconds: number;
	rangeStartSeconds: number;
	rangeEndSeconds: number;
} {
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!scene) throw new Error("No active scene");
	const target = findTemplateVideoTarget({ tracks: scene.tracks });
	if (!target) throw new Error("Import a video before applying a template");
	const totalDuration = calculateTotalDuration({ tracks: scene.tracks });
	const totalDurationSeconds = totalDuration / 120_000;
	const opening = UI_ELEMENT_PRESETS.find((preset) => preset.id === "color-reveal-whoosh");
	const commands = [];
	if (opening?.bundle && totalDurationSeconds >= 3) {
		for (const item of buildUiElementBundleTimelineItems({
			bundle: opening.bundle,
			startTime: ZERO_MEDIA_TIME,
		})) {
			commands.push(
				new InsertElementCommand({
					element: item.element,
					placement: { mode: "auto", trackType: item.trackType },
				}),
			);
		}
	}
	const checklist = UI_ELEMENT_PRESETS.find(
		(preset) => preset.id === "rtl-cancellation-checklist-sfx",
	);
	const checklistStartSeconds = findChecklistStartSeconds({ tracks: scene.tracks });
	const checklistAlreadyExists = getDisplayTracks({ tracks: scene.tracks }).some((track) =>
		track.elements.some((element) => element.name.includes("Cancellation Checklist")),
	);
	if (checklist?.bundle && checklistStartSeconds !== null && !checklistAlreadyExists) {
		const safeStartSeconds = Math.min(
			checklistStartSeconds,
			Math.max(0, totalDurationSeconds - checklist.defaultDurationSeconds),
		);
		for (const item of buildUiElementBundleTimelineItems({
			bundle: checklist.bundle,
			startTime: mediaTimeFromSeconds({ seconds: safeStartSeconds }),
		})) {
			commands.push(
				new InsertElementCommand({
					element: item.element,
					placement: { mode: "auto", trackType: item.trackType },
				}),
			);
		}
	}
	const hasEditorialEdgeFeather = target.element.effects?.some(
		(effect) => effect.type === EDITORIAL_EDGE_FEATHER_EFFECT_TYPE,
	);
	if (!hasEditorialEdgeFeather) {
		commands.push(
			new AddClipEffectCommand({
				trackId: target.trackId,
				elementId: target.element.id,
				effectType: EDITORIAL_EDGE_FEATHER_EFFECT_TYPE,
				params: PAPER_GRID_EDITORIAL_EDGE_FEATHER_PARAMS,
			}),
		);
	}
	if (commands.length > 0) {
		editor.command.execute({ command: new BatchCommand(commands) });
	}

	const captionUpdates = getDisplayTracks({ tracks: scene.tracks }).flatMap(
		(track) => {
			if (track.type !== "text") return [];
			return track.elements.flatMap((element) => {
				if (element.type !== "text" || !element.name.startsWith("Caption")) {
					return [];
				}
				return [
					{
						trackId: track.id,
						elementId: element.id,
						patch: {
							params: {
								...element.params,
								color: "#ffffff",
								fontFamily: "Arial",
								fontWeight: "bold",
								fontSize: 4,
								"shadow.blur": 50,
								"shadow.color": "#000000",
								"shadow.enabled": true,
								"shadow.offsetY": 4,
							},
						},
					},
				];
			});
		},
	);
	if (captionUpdates.length > 0) editor.timeline.updateElements({ updates: captionUpdates });

	return {
		target,
		totalDurationSeconds,
		rangeStartSeconds: target.element.startTime / 120_000,
		rangeEndSeconds: (target.element.startTime + target.element.duration) / 120_000,
	};
}

export function applyTemplateAiCompletion({
	editor,
	plan,
}: {
	editor: EditorCore;
	plan: TemplateAiPlan;
}): void {
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!scene) return;
	const proofStart = plan.proofStage
		? Math.min(plan.proofStage.startSeconds, plan.proofStage.endSeconds)
		: null;
	const proofEnd = plan.proofStage
		? Math.max(plan.proofStage.startSeconds, plan.proofStage.endSeconds)
		: null;
	const captionUpdates = getDisplayTracks({ tracks: scene.tracks }).flatMap((track) => {
		if (track.type !== "text") return [];
		return track.elements.flatMap((element) => {
			if (element.type !== "text" || !element.name.startsWith("Caption")) return [];
			const startSeconds = mediaTimeToSeconds({ time: element.startTime });
			const endSeconds = mediaTimeToSeconds({
				time: addMediaTime({ a: element.startTime, b: element.duration }),
			});
			const onProofStage =
				proofStart !== null &&
				proofEnd !== null &&
				startSeconds < proofEnd &&
				endSeconds > proofStart;
			return [{
				trackId: track.id,
				elementId: element.id,
				patch: {
					params: {
						...element.params,
						color: onProofStage ? "#111827" : "#ffffff",
						"shadow.blur": onProofStage ? 14 : 50,
						"shadow.color": onProofStage ? "#00000024" : "#000000",
						"shadow.enabled": true,
						"shadow.offsetY": 4,
					},
				},
			}];
		});
	});
	const checklist = plan.checklist;
	const checklistUpdates = checklist
		? getDisplayTracks({ tracks: scene.tracks }).flatMap((track) => {
				if (track.type !== "graphic") return [];
				return track.elements.flatMap((element) => {
					if (!element.name.includes("Cancellation Checklist")) return [];
					const startSeconds = mediaTimeToSeconds({ time: element.startTime });
					const durationSeconds = mediaTimeToSeconds({ time: element.duration });
					const percent = (value: number) =>
						Math.max(0, Math.min(100, ((value - startSeconds) / durationSeconds) * 100));
					return [{
						trackId: track.id,
						elementId: element.id,
						patch: {
							params: {
								...element.params,
								eventAt: percent(checklist.eventSeconds),
								animationOutStart: percent(checklist.endSeconds),
							},
						},
					}];
				});
			})
		: [];
	const updates = [...captionUpdates, ...checklistUpdates];
	if (updates.length > 0) editor.timeline.updateElements({ updates });
}

export async function applyBreakoutPlacements({
	editor,
	target,
	placements,
	onProgress,
}: {
	editor: EditorCore;
	target: TemplateVideoTarget;
	placements: BreakoutPlacement[];
	onProgress?: (message: string) => void;
}): Promise<number> {
	let applied = 0;
	for (const placement of placements) {
		const startTime = mediaTimeFromSeconds({ seconds: placement.startSeconds });
		const duration = mediaTimeFromSeconds({ seconds: placement.durationSeconds });
		const ref = editor.timeline.createSpeakerFrameBreakout({
			trackId: target.trackId,
			elementId: target.element.id,
			options: {
				name: "Template · Paper Grid Speaker Breakout",
				startTime,
				duration,
				backgroundPresetId: "paper-grid",
				positionX: 0,
				positionY: 410,
				scaleX: 0.7,
				scaleY: 0.7,
				cropTop: 0.22,
				cornerRadius: 0.08,
			},
		});
		if (!ref) continue;
		const updatedScene = editor.scenes.getActiveScene();
		const layer = getDisplayTracks({ tracks: updatedScene.tracks })
			.find((track) => track.id === ref.trackId)
			?.elements.find((element) => element.id === ref.elementId);
		if (!layer || layer.type !== "effect") continue;
		onProgress?.(`Preparing breakout ${applied + 1}/${placements.length}`);
		await editor.timeline.applySpeakerFrameBreakout({
			trackId: ref.trackId,
			elementId: ref.elementId,
			params: layer.params,
		});
		applied += 1;
	}
	return applied;
}
