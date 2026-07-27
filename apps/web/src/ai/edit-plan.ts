import { z } from "zod";
import type { EditorCore } from "@/core";
import {
	VISUAL_ELEMENT_TYPES,
	type CreateTextElement,
	type CreateTimelineElement,
	type ElementType,
	type SceneTracks,
	type TScene,
	type TimelineElement,
} from "@/timeline/types";
import { DEFAULTS } from "@/timeline/defaults";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import type { AnimationPath } from "@/animation/types";
import { isAnimationPath } from "@/animation/path";
import {
	mediaTime,
	mediaTimeFromSeconds,
	ZERO_MEDIA_TIME,
	type MediaTime,
} from "@/wasm";
import type { ParamValue } from "@/params";
import {
	buildEffectElement,
	buildElementFromMedia,
	buildGraphicElement,
	buildLibraryAudioElement,
	buildStickerElement,
} from "@/timeline/element-utils";
import { validateElementTrackCompatibility } from "@/timeline/placement";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { graphicsRegistry, registerDefaultGraphics } from "@/graphics";
import {
	DEFAULT_HYPERFRAME_HEIGHT,
	DEFAULT_HYPERFRAME_WIDTH,
	HYPERFRAME_DEFINITION_ID,
} from "@/graphics/definitions/hyperframe";
import { TRANSITION_PRESETS } from "@/transitions";
import type { MediaAsset } from "@/media/types";
import type { AiEditOperation, AiEditPlan, AiTimelineRange } from "./types";
import {
	buildTimelineContextIndex,
	getDisplayTracks,
	rangesOverlap,
} from "./timeline-context";
import {
	buildCustomAiEffectParams,
	CUSTOM_AI_EFFECT_TYPE,
} from "@/effects/custom-ai-effect";
import { effectsRegistry, registerDefaultEffects } from "@/effects";
import { getDefaultBackgroundRemovalSettings } from "@/background-removal";
import type { TProjectSettings } from "@/project/types";
import type { ExportState } from "@/export";
import type { TranscriptionTaskState } from "@/core/managers/transcription-manager";
import { TRANSCRIPTION_LANGUAGES } from "@/transcription/supported-languages";
import type { TranscriptionLanguage } from "@/transcription/types";
import {
	buildDefaultScene,
	getFallbackSceneAfterDelete,
	updateSceneInArray,
} from "@/timeline/scenes";
import {
	getFrameTime,
	moveBookmarkInArray,
	removeBookmarkFromArray,
	updateBookmarkInArray,
} from "@/timeline/bookmarks";
import {
	buildTimelineDocumentV2,
	parseTimelineDocumentV2,
} from "./timeline-document-v2";
import { validateTimelineDocumentV2MutationScope } from "./timeline-document-v2-scope";
import type { TimelineDocumentV2MutationScopeValidator } from "./timeline-document-v2-scope";
import {
	appendAiEditPlanRecord,
	buildAiEditPlanProvenanceRecord,
} from "./edit-provenance";
import { getCreativePlanQualityNotes } from "./creative-plan-quality";

const mediaTimeSchema = z.custom<MediaTime>(
	(value) => typeof value === "number" && Number.isInteger(value) && value >= 0,
	"Expected a non-negative integer media time",
);
const positiveMediaTimeSchema = z.custom<MediaTime>(
	(value) => typeof value === "number" && Number.isInteger(value) && value > 0,
	"Expected a positive integer media time",
);
const paramValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const paramsSchema = z.record(z.string(), paramValueSchema);
const MAX_TIMELINE_SOURCE_V2_CHARS = 1_000_000;
type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(jsonValueSchema),
		z.record(z.string(), jsonValueSchema),
	]),
);
const customEditSpecSchema = jsonValueSchema;
const ELEMENT_PATCH_FIELDS = new Set([
	"name",
	"params",
	"animations",
	"transitions",
	"effects",
	"masks",
	"backgroundRemoval",
	"sourceDuration",
	"isSourceAudioEnabled",
	"wordRuns",
	"textRowOverrides",
	"captionWordAnimationId",
	"captionRevealMode",
	"captionTransitionIn",
	"captionAccentColor",
	"captionWordDirection",
	"captionGlowerEnabled",
	"captionGlowerDirection",
	"captionLightningStormEnabled",
	"captionGlitchyEnabled",
	"clipMediaId",
	"intrinsicWidth",
	"intrinsicHeight",
]);
const elementPatchSchema = z
	.record(z.string(), jsonValueSchema)
	.superRefine((patch, context) => {
		if (Object.keys(patch).length === 0) {
			context.addIssue({
				code: "custom",
				message: "update_element patch must change at least one field",
			});
		}
		for (const key of Object.keys(patch)) {
			if (!ELEMENT_PATCH_FIELDS.has(key)) {
				context.addIssue({
					code: "custom",
					message: `update_element cannot patch ${key}; use its dedicated operation`,
					path: [key],
				});
			}
		}
		if (
			"name" in patch &&
			(typeof patch.name !== "string" || !patch.name.trim())
		) {
			context.addIssue({
				code: "custom",
				message: "update_element name must be a non-empty string",
				path: ["name"],
			});
		}
	});

const operationSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("apply_timeline_source_v2"),
		baseRevision: z.string().min(1).max(128),
		document: z.string().min(1).max(MAX_TIMELINE_SOURCE_V2_CHARS),
		scope: z
			.object({
				startTime: mediaTimeSchema,
				endTime: mediaTimeSchema,
			})
			.strict()
			.refine((scope) => scope.endTime >= scope.startTime, {
				message: "scope endTime must be at or after startTime",
			})
			.optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("update_element"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		patch: elementPatchSchema,
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("insert_text_element"),
		trackId: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
		content: z.string().min(1),
		startTime: mediaTimeSchema,
		duration: positiveMediaTimeSchema,
		params: paramsSchema.optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("trim_element"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		trimStart: mediaTimeSchema.optional(),
		trimEnd: mediaTimeSchema.optional(),
		startTime: mediaTimeSchema.optional(),
		duration: mediaTimeSchema.optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("move_element"),
		sourceTrackId: z.string().min(1),
		targetTrackId: z.string().min(1),
		elementId: z.string().min(1),
		startTime: mediaTimeSchema,
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("split_element"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		splitTime: mediaTimeSchema,
		retainSide: z.enum(["both", "left", "right"]).optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("delete_element"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("add_clip_effect"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		effectType: z.string().min(1),
		params: paramsSchema.optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("attach_custom_edit"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		label: z.string().min(1),
		kind: z.string().min(1).optional(),
		intent: z.string().min(1).optional(),
		startTime: mediaTimeSchema.optional(),
		duration: positiveMediaTimeSchema.optional(),
		spec: customEditSpecSchema,
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("update_clip_effect_params"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		effectId: z.string().min(1),
		params: paramsSchema,
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("remove_clip_effect"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		effectId: z.string().min(1),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("set_clip_effect_enabled"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		effectId: z.string().min(1),
		enabled: z.boolean(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("reorder_clip_effect"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		fromIndex: z.number().int().min(0),
		toIndex: z.number().int().min(0),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("set_background_removal"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		enabled: z.boolean(),
		mode: z.enum(["remove", "blur", "grayscale"]).optional(),
		quality: z.enum(["fast", "balanced", "precise"]).optional(),
		maskThreshold: z.number().min(0.05).max(0.95).optional(),
		edgeContrast: z.number().min(0.5).max(2.5).optional(),
		edgeFeather: z.number().min(0).max(8).optional(),
		temporalSmoothing: z.number().min(0).max(0.85).optional(),
		blurStrength: z.number().min(0).max(1).optional(),
		duplicate: z.boolean().optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("upsert_keyframe"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		propertyPath: z.string().min(1),
		time: mediaTimeSchema,
		value: paramValueSchema,
		interpolation: z.enum(["linear", "hold"]).optional(),
		keyframeId: z.string().optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("remove_keyframe"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		propertyPath: z.string().min(1),
		keyframeId: z.string().min(1),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("add_track"),
		trackType: z.enum(["video", "text", "audio", "graphic", "effect"]),
		index: z.number().int().min(0).optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("remove_track"),
		trackId: z.string().min(1),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("reorder_track"),
		trackId: z.string().min(1),
		toIndex: z.number().int().min(0),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("set_track_state"),
		trackId: z.string().min(1),
		muted: z.boolean().optional(),
		hidden: z.boolean().optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("create_scene"),
		name: z.string().trim().min(1).max(100),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("rename_scene"),
		sceneId: z.string().min(1),
		name: z.string().trim().min(1).max(100),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("delete_scene"),
		sceneId: z.string().min(1),
		reason: z.string().optional(),
	}),
	z
		.object({
			type: z.literal("set_project_settings"),
			fps: z
				.object({
					numerator: z.number().int().min(1).max(240_000),
					denominator: z.number().int().min(1).max(10_000),
				})
				.strict()
				.optional(),
			canvasSize: z
				.object({
					width: z.number().int().min(16).max(8_192),
					height: z.number().int().min(16).max(8_192),
				})
				.strict()
				.optional(),
			background: z
				.discriminatedUnion("type", [
					z.object({
						type: z.literal("color"),
						color: z.string().min(1).max(50),
					}),
					z.object({
						type: z.literal("blur"),
						blurIntensity: z.number().min(0).max(100),
					}),
				])
				.optional(),
			reason: z.string().optional(),
		})
		.strict()
		.refine(
			(value) =>
				value.fps !== undefined ||
				value.canvasSize !== undefined ||
				value.background !== undefined,
			{ message: "set_project_settings must change at least one setting" },
		),
	z.object({
		type: z.literal("add_bookmark"),
		time: mediaTimeSchema,
		note: z.string().max(500).optional(),
		color: z.string().min(1).max(50).optional(),
		duration: positiveMediaTimeSchema.optional(),
		reason: z.string().optional(),
	}),
	z
		.object({
			type: z.literal("update_bookmark"),
			time: mediaTimeSchema,
			note: z.string().max(500).optional(),
			color: z.string().min(1).max(50).optional(),
			duration: positiveMediaTimeSchema.optional(),
			reason: z.string().optional(),
		})
		.refine(
			(value) =>
				value.note !== undefined ||
				value.color !== undefined ||
				value.duration !== undefined,
			{ message: "update_bookmark must change note, color, or duration" },
		),
	z.object({
		type: z.literal("remove_bookmark"),
		time: mediaTimeSchema,
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("move_bookmark"),
		fromTime: mediaTimeSchema,
		toTime: mediaTimeSchema,
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("start_export_task"),
		format: z.enum(["mp4", "webm"]),
		quality: z.enum(["low", "medium", "high", "very_high"]),
		includeAudio: z.boolean().optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("start_transcription_task"),
		language: z.string().trim().min(2).max(16).optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("insert_media_element"),
		mediaId: z.string().min(1),
		startTime: mediaTimeSchema,
		trackId: z.string().min(1).optional(),
		duration: positiveMediaTimeSchema.optional(),
		name: z.string().min(1).optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("insert_library_audio_element"),
		libraryAssetId: z.string().min(1),
		name: z.string().min(1),
		startTime: mediaTimeSchema,
		duration: positiveMediaTimeSchema,
		trackId: z.string().min(1).optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("insert_graphic_element"),
		definitionId: z.string().min(1),
		startTime: mediaTimeSchema,
		duration: positiveMediaTimeSchema,
		trackId: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
		params: paramsSchema.optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("insert_html_element"),
		html: z.string().min(1),
		startTime: mediaTimeSchema,
		duration: positiveMediaTimeSchema,
		trackId: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
		sourceWidth: z.number().int().min(16).max(4096).optional(),
		sourceHeight: z.number().int().min(16).max(4096).optional(),
		params: paramsSchema.optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("insert_sticker_element"),
		stickerId: z.string().min(1),
		startTime: mediaTimeSchema,
		duration: positiveMediaTimeSchema,
		trackId: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
		intrinsicWidth: z.number().positive().optional(),
		intrinsicHeight: z.number().positive().optional(),
		params: paramsSchema.optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("insert_effect_element"),
		effectType: z.string().min(1),
		startTime: mediaTimeSchema,
		duration: positiveMediaTimeSchema,
		trackId: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
		params: paramsSchema.optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("duplicate_element"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("apply_transition"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		presetId: z.string().min(1),
		side: z.enum(["in", "out"]),
		percent: z.number().min(0).max(100).optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("set_element_state"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		hidden: z.boolean().optional(),
		muted: z.boolean().optional(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("retime_element"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		rate: z.number().min(0.1).max(10),
		maintainPitch: z.boolean().optional(),
		reason: z.string().optional(),
	}),
]);

export const aiEditPlanSchema = z.object({
	title: z.string().min(1).default("AI edit plan"),
	summary: z.string().default(""),
	operations: z.array(operationSchema).default([]),
	notes: z.array(z.string()).optional(),
});

export interface ValidateAiEditPlanResult {
	success: boolean;
	plan: AiEditPlan | null;
	errors: string[];
}

export function validateAiEditPlan({
	value,
	tracks,
	range,
	mediaAssets,
	scenes,
	activeSceneId,
	projectSettings,
	exportState,
	transcriptionState,
	timelineSourceV2ScopeValidator,
}: {
	value: unknown;
	tracks: SceneTracks;
	range?: AiTimelineRange | null;
	mediaAssets?: MediaAsset[];
	scenes?: TScene[];
	activeSceneId?: string;
	projectSettings?: TProjectSettings;
	exportState?: ExportState;
	transcriptionState?: TranscriptionTaskState;
	timelineSourceV2ScopeValidator?: TimelineDocumentV2MutationScopeValidator;
}): ValidateAiEditPlanResult {
	const parsed = aiEditPlanSchema.safeParse(normalizeAiEditPlanInput(value));
	if (!parsed.success) {
		return {
			success: false,
			plan: null,
			errors: parsed.error.issues.map((issue) =>
				issue.path.length > 0
					? `${issue.path.join(".")}: ${issue.message}`
					: issue.message,
			),
		};
	}

	const parsedPlan = parsed.data as AiEditPlan;
	const qualityNotes = getAiEditPlanQualityNotes({
		title: parsedPlan.title,
		summary: parsedPlan.summary,
		operations: parsedPlan.operations,
	});
	const uniqueNotes = [
		...new Set([...(parsedPlan.notes ?? []), ...qualityNotes]),
	];
	const plan: AiEditPlan = {
		...parsedPlan,
		...(uniqueNotes.length > 0 ? { notes: uniqueNotes } : {}),
	};
	const errors = getRangeGuardErrors({
		operations: plan.operations,
		tracks,
		range,
		mediaAssets,
		scenes,
		activeSceneId,
		projectSettings,
		exportState,
		transcriptionState,
		timelineSourceV2ScopeValidator,
	});
	return {
		success: errors.length === 0,
		plan,
		errors,
	};
}

export function getAiEditPlanQualityNotes({
	title,
	summary,
	operations,
}: {
	title?: string;
	summary?: string;
	operations: AiEditOperation[];
}): string[] {
	return getCreativePlanQualityNotes({ title, summary, operations });
}

export function applyAiEditPlan({
	editor,
	plan,
	range,
	timelineSourceV2ScopeValidator,
}: {
	editor: EditorCore;
	plan: AiEditPlan;
	range?: AiTimelineRange | null;
	timelineSourceV2ScopeValidator?: TimelineDocumentV2MutationScopeValidator;
}): void {
	const taskOperation = plan.operations.find(
		(operation) =>
			operation.type === "start_export_task" ||
			operation.type === "start_transcription_task",
	);
	if (taskOperation) {
		if (plan.operations.length !== 1) {
			throw new Error("Tasks cannot be mixed with project edit operations");
		}
		if (taskOperation.type === "start_export_task") {
			startExportTask({ editor, operation: taskOperation });
		} else {
			startTranscriptionTask({ editor, operation: taskOperation });
		}
		return;
	}
	const fullSourceOperation = plan.operations.find(
		(operation) => operation.type === "apply_timeline_source_v2",
	);
	if (fullSourceOperation && plan.operations.length !== 1) {
		throw new Error(
			"apply_timeline_source_v2 cannot be mixed with other operations",
		);
	}
	if (
		fullSourceOperation &&
		range &&
		(!fullSourceOperation.scope ||
			fullSourceOperation.scope.startTime !== range.startTime ||
			fullSourceOperation.scope.endTime !== range.endTime)
	) {
		throw new Error(
			"apply_timeline_source_v2 scope does not match the active selected range",
		);
	}

	const preApplyScene = editor.scenes.getActiveSceneOrNull();
	const canRecordProvenance = Boolean(
		preApplyScene &&
		editor.project?.getActiveOrNull?.() &&
		typeof editor.project?.setActiveProject === "function",
	);
	const executePlan = () => {
		const provenanceRecord =
			preApplyScene && canRecordProvenance
				? buildAiEditPlanProvenanceRecord({
						plan,
						scene: preApplyScene,
						range,
					})
				: null;
		for (const operation of plan.operations) {
			applyOperation({
				editor,
				operation,
				timelineSourceV2ScopeValidator,
			});
		}
		if (provenanceRecord) {
			const project = editor.project.getActiveOrNull();
			if (!project) {
				throw new Error(
					"The active project changed while applying the AI plan",
				);
			}
			editor.project.setActiveProject({
				project: appendAiEditPlanRecord({
					project,
					record: provenanceRecord,
				}),
			});
			editor.save?.markDirty?.();
		}
	};
	if (editor.command?.executeTransaction) {
		editor.command.executeTransaction({ execute: executePlan });
		return;
	}

	// Lightweight adapters used by tests and embedders may not expose the
	// command manager yet. Preserve the previous rollback guarantee for them.
	const previousTracks = editor.scenes.getActiveSceneOrNull()?.tracks;
	try {
		executePlan();
	} catch (error) {
		if (previousTracks) editor.timeline.updateTracks(previousTracks);
		throw error;
	}
}

function startTranscriptionTask({
	editor,
	operation,
}: {
	editor: EditorCore;
	operation: Extract<AiEditOperation, { type: "start_transcription_task" }>;
}): void {
	const state = editor.transcription.getState();
	if (state.task.status === "running" || state.task.status === "cancelling") {
		throw new Error("A transcription task is already running");
	}
	const language = operation.language ?? "auto";
	if (!isSupportedTranscriptionLanguage(language)) {
		throw new Error(`Unsupported transcription language: ${language}`);
	}
	void editor.transcription.start({ language });
}

function isSupportedTranscriptionLanguage(
	language: string,
): language is TranscriptionLanguage {
	return (
		language === "auto" ||
		TRANSCRIPTION_LANGUAGES.some((candidate) => candidate.code === language)
	);
}

function startExportTask({
	editor,
	operation,
}: {
	editor: EditorCore;
	operation: Extract<AiEditOperation, { type: "start_export_task" }>;
}): void {
	const state = editor.project.getExportState();
	if (state.isExporting) {
		throw new Error("An export task is already running");
	}
	if (state.result?.success && state.result.buffer) {
		throw new Error(
			"An exported file is already ready; download or clear it before starting another export",
		);
	}
	const project = editor.project.getActive();
	void editor.project.export({
		options: {
			format: operation.format,
			quality: operation.quality,
			fps: project.settings.fps,
			includeAudio: operation.includeAudio ?? true,
		},
	});
}

export function extractAiEditPlanFromText(text: string): unknown | null {
	const trimmed = text.trim();
	if (!trimmed) {
		return null;
	}

	const parsedFullText = parseJsonRecursively({ text: trimmed });
	if (parsedFullText) {
		return normalizeAiEditPlanInput(parsedFullText);
	}

	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) {
		const parsedFence = parseJsonRecursively({ text: fenced[1].trim() });
		if (parsedFence) {
			return normalizeAiEditPlanInput(parsedFence);
		}
	}

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		const parsedSlice = parseJsonRecursively({
			text: trimmed.slice(firstBrace, lastBrace + 1),
		});
		if (parsedSlice) {
			return normalizeAiEditPlanInput(parsedSlice);
		}
	}

	return null;
}

function parseJsonRecursively({
	text,
	depth = 0,
}: {
	text: string;
	depth?: number;
}): unknown | null {
	if (depth > 2) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "string") {
			return parseJsonRecursively({ text: parsed.trim(), depth: depth + 1 });
		}
		return parsed;
	} catch {
		return null;
	}
}

function normalizeAiEditPlanInput(value: unknown): unknown {
	if (!isRecord(value)) {
		return value;
	}
	if (!Array.isArray(value.operations)) {
		return value;
	}
	return {
		...value,
		operations: value.operations.map(normalizeAiEditOperationInput),
	};
}

function normalizeAiEditOperationInput(value: unknown): unknown {
	if (!isRecord(value)) {
		return value;
	}
	if (
		(value.type === "upsert_keyframe" || value.type === "remove_keyframe") &&
		typeof value.propertyPath !== "string"
	) {
		const alias =
			typeof value.property === "string"
				? value.property
				: typeof value.path === "string"
					? value.path
					: null;
		if (alias) {
			const { property: _property, path: _path, ...rest } = value;
			return { ...rest, propertyPath: alias };
		}
		return value;
	}
	if (value.type !== "update_element") {
		return value;
	}
	if (isRecord(value.patch)) {
		return value;
	}
	const params = isRecord(value.params) ? value.params : null;
	if (params) {
		return {
			...value,
			patch: { params },
		};
	}
	if (typeof value.content === "string") {
		return {
			...value,
			patch: { params: { content: value.content } },
		};
	}
	if (typeof value.text === "string") {
		return {
			...value,
			patch: { params: { content: value.text } },
		};
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRangeGuardErrors({
	operations,
	tracks,
	range,
	mediaAssets,
	scenes,
	activeSceneId,
	projectSettings,
	exportState,
	transcriptionState,
	timelineSourceV2ScopeValidator,
}: {
	operations: AiEditOperation[];
	tracks: SceneTracks;
	range?: AiTimelineRange | null;
	mediaAssets?: MediaAsset[];
	scenes?: TScene[];
	activeSceneId?: string;
	projectSettings?: TProjectSettings;
	exportState?: ExportState;
	transcriptionState?: TranscriptionTaskState;
	timelineSourceV2ScopeValidator?: TimelineDocumentV2MutationScopeValidator;
}): string[] {
	const index = buildTimelineContextIndex({ tracks });
	const displayTracks = getDisplayTracks(tracks);
	const errors: string[] = [];
	const exportTasks = operations.filter(
		(operation) => operation.type === "start_export_task",
	);
	if (exportTasks.length > 0) {
		if (operations.length !== 1) {
			errors.push(
				"start_export_task must be the only operation in a reviewed plan",
			);
		}
		if (range) {
			errors.push("start_export_task is not available in range editing");
		}
		if (exportState?.isExporting) {
			errors.push("An export task is already running");
		}
		if (exportState?.result?.success && exportState.result.buffer) {
			errors.push(
				"An exported file is already ready; download or clear it before starting another export",
			);
		}
	}
	const transcriptionTasks = operations.filter(
		(operation) => operation.type === "start_transcription_task",
	);
	if (transcriptionTasks.length > 0) {
		if (operations.length !== 1) {
			errors.push(
				"start_transcription_task must be the only operation in a reviewed plan",
			);
		}
		if (range) {
			errors.push("start_transcription_task is not available in range editing");
		}
		if (
			transcriptionState?.task.status === "running" ||
			transcriptionState?.task.status === "cancelling"
		) {
			errors.push("A transcription task is already running");
		}
		const requestedLanguage = transcriptionTasks[0]?.language ?? "auto";
		if (!isSupportedTranscriptionLanguage(requestedLanguage)) {
			errors.push(`Unsupported transcription language: ${requestedLanguage}`);
		}
	}
	const fullSourceOperations = operations.filter(
		(operation) => operation.type === "apply_timeline_source_v2",
	);
	if (fullSourceOperations.length > 0 && operations.length !== 1) {
		errors.push(
			"apply_timeline_source_v2 must be the only operation in a reviewed plan",
		);
	}

	for (const operation of operations) {
		if (
			operation.type === "start_export_task" ||
			operation.type === "start_transcription_task"
		) {
			continue;
		}
		if (operation.type === "create_scene") {
			continue;
		}

		if (operation.type === "apply_timeline_source_v2") {
			errors.push(
				...getTimelineSourceV2OperationErrors({
					operation,
					range,
					mediaAssets,
					scenes,
					activeSceneId,
					projectSettings,
					timelineSourceV2ScopeValidator,
				}),
			);
			continue;
		}

		if (
			operation.type === "rename_scene" ||
			operation.type === "delete_scene"
		) {
			if (!scenes) {
				errors.push(`${operation.type} requires current scene context`);
				continue;
			}
			const targetScene = scenes.find(
				(candidate) => candidate.id === operation.sceneId,
			);
			if (!targetScene) {
				errors.push(
					`${operation.type} references a missing scene ${operation.sceneId}`,
				);
			} else if (operation.type === "delete_scene" && targetScene.isMain) {
				errors.push("delete_scene cannot delete the main scene");
			}
			continue;
		}

		if (operation.type === "set_project_settings") {
			continue;
		}

		if (
			operation.type === "add_bookmark" ||
			operation.type === "update_bookmark" ||
			operation.type === "remove_bookmark" ||
			operation.type === "move_bookmark"
		) {
			const activeScene = scenes?.find(
				(candidate) => candidate.id === activeSceneId,
			);
			if (!activeScene || !projectSettings) {
				errors.push(
					`${operation.type} requires active scene and project context`,
				);
				continue;
			}
			const sourceTime = getFrameTime({
				time:
					operation.type === "move_bookmark"
						? operation.fromTime
						: operation.time,
				fps: projectSettings.fps,
			});
			const existing = activeScene.bookmarks.some(
				(bookmark) => bookmark.time === sourceTime,
			);
			if (operation.type === "add_bookmark" && existing) {
				errors.push(`add_bookmark already exists at ${sourceTime}`);
			}
			if (operation.type !== "add_bookmark" && !existing) {
				errors.push(
					`${operation.type} references a missing bookmark at ${sourceTime}`,
				);
			}
			const targetTime =
				operation.type === "move_bookmark"
					? getFrameTime({ time: operation.toTime, fps: projectSettings.fps })
					: sourceTime;
			if (
				operation.type === "move_bookmark" &&
				targetTime !== sourceTime &&
				activeScene.bookmarks.some((bookmark) => bookmark.time === targetTime)
			) {
				errors.push(`move_bookmark target already exists at ${targetTime}`);
			}
			if (
				range &&
				(sourceTime < range.startTime ||
					sourceTime > range.endTime ||
					targetTime < range.startTime ||
					targetTime > range.endTime)
			) {
				errors.push(`${operation.type} is outside the selected range`);
			}
			continue;
		}

		if (operation.type === "add_track") {
			continue;
		}

		if (
			operation.type === "remove_track" ||
			operation.type === "reorder_track" ||
			operation.type === "set_track_state"
		) {
			if (!index.layersById.has(operation.trackId)) {
				errors.push(
					`${operation.type} references a missing track ${operation.trackId}`,
				);
			}
			continue;
		}

		if (
			operation.type === "insert_media_element" ||
			operation.type === "insert_library_audio_element" ||
			operation.type === "insert_graphic_element" ||
			operation.type === "insert_html_element" ||
			operation.type === "insert_sticker_element" ||
			operation.type === "insert_effect_element"
		) {
			errors.push(
				...getInsertOperationErrors({
					operation,
					index,
					displayTracks,
					range,
					mediaAssets,
				}),
			);
			continue;
		}

		if (operation.type === "apply_transition") {
			if (
				!TRANSITION_PRESETS.some((preset) => preset.id === operation.presetId)
			) {
				errors.push(
					`apply_transition references an unknown transition preset ${operation.presetId}`,
				);
			}
		}

		if (operation.type === "insert_text_element") {
			if (operation.trackId) {
				const layer = index.layersById.get(operation.trackId);
				if (!layer) {
					errors.push(
						`insert_text_element references a missing track ${operation.trackId}`,
					);
				} else if (layer.type !== "text") {
					errors.push(
						`insert_text_element target track ${operation.trackId} is not a text track`,
					);
				}
			}

			if (range) {
				const endTime = operation.startTime + operation.duration;
				if (operation.startTime < range.startTime || endTime > range.endTime) {
					errors.push("insert_text_element is outside the selected range");
				}
			}

			continue;
		}

		if (operation.type === "move_element") {
			const source = findTrackAndElement({
				tracks: displayTracks,
				trackId: operation.sourceTrackId,
				elementId: operation.elementId,
			});
			const targetTrack = displayTracks.find(
				(track) => track.id === operation.targetTrackId,
			);
			if (!targetTrack) {
				errors.push(
					`move_element references a missing target track ${operation.targetTrackId}`,
				);
			} else if (source?.element) {
				const validation = validateElementTrackCompatibility({
					element: source.element,
					track: targetTrack,
				});
				if (!validation.isValid) {
					errors.push(
						validation.errorMessage ??
							`move_element cannot move ${source.element.name} to ${targetTrack.name}`,
					);
				}
			}
			if (range && source?.element) {
				const movedEndTime = operation.startTime + source.element.duration;
				if (
					operation.startTime < range.startTime ||
					movedEndTime > range.endTime
				) {
					errors.push(
						"move_element target timing is outside the selected range",
					);
				}
			}
		}

		const refs = getOperationElementRefs(operation);
		for (const ref of refs) {
			const element = index.elementsById.get(`${ref.trackId}:${ref.elementId}`);
			if (!element) {
				errors.push(
					`${operation.type} references a missing element ${ref.elementId}`,
				);
				continue;
			}
			if (
				range &&
				!rangesOverlap({
					firstStart: element.startTime,
					firstEnd: element.endTime,
					secondStart: range.startTime,
					secondEnd: range.endTime,
				})
			) {
				errors.push(
					`${operation.type} references ${element.name} outside the selected range`,
				);
			}
			const targetIsVisual = isVisualElementType({ type: element.type });
			if (isClipEffectOperation(operation) && !targetIsVisual) {
				errors.push(
					`${operation.type} target ${element.name} is not a visual element`,
				);
			}
			if (operation.type === "apply_transition" && !targetIsVisual) {
				errors.push(
					`apply_transition target ${element.name} is not a visual element`,
				);
			}
			if (
				operation.type === "retime_element" &&
				element.type !== "video" &&
				element.type !== "audio"
			) {
				errors.push(
					`retime_element target ${element.name} is not a video or audio element`,
				);
			}
			if (operation.type === "set_element_state") {
				if (operation.hidden !== undefined && !targetIsVisual) {
					errors.push(
						`set_element_state cannot hide ${element.name}; it is not a visual element`,
					);
				}
				if (
					operation.muted !== undefined &&
					element.type !== "video" &&
					element.type !== "audio"
				) {
					errors.push(
						`set_element_state cannot mute ${element.name}; it has no audio`,
					);
				}
			}
			const effectId = getReferencedEffectId(operation);
			if (
				effectId &&
				targetIsVisual &&
				!element.effects?.some((effect) => effect.id === effectId)
			) {
				errors.push(
					`${operation.type} references a missing effect ${effectId}`,
				);
			}
			if (
				operation.type === "reorder_clip_effect" &&
				(operation.fromIndex >= (element.effects?.length ?? 0) ||
					operation.toIndex >= (element.effects?.length ?? 0))
			) {
				errors.push("reorder_clip_effect indexes are outside the effect stack");
			}
			if (
				operation.type === "set_background_removal" &&
				element.type !== "video"
			) {
				errors.push(
					`set_background_removal target ${element.name} is not a video element`,
				);
			}
			if (
				operation.type === "upsert_keyframe" ||
				operation.type === "remove_keyframe"
			) {
				const target = findTrackAndElement({
					tracks: displayTracks,
					trackId: ref.trackId,
					elementId: ref.elementId,
				});
				if (!isAnimationPath(operation.propertyPath)) {
					errors.push(
						`${operation.type} references an unsupported animation path ${operation.propertyPath}`,
					);
				} else if (
					target?.element &&
					!resolveAnimationTarget({
						element: target.element,
						path: operation.propertyPath,
					})
				) {
					errors.push(
						`${operation.type} cannot animate ${operation.propertyPath} on ${target.element.name}`,
					);
				}

				if (
					operation.type === "upsert_keyframe" &&
					range &&
					(element.startTime + operation.time < range.startTime ||
						element.startTime + operation.time > range.endTime)
				) {
					errors.push("upsert_keyframe time is outside the selected range");
				}

				if (
					operation.type === "upsert_keyframe" &&
					isAnimationPath(operation.propertyPath) &&
					target?.element
				) {
					const animationTarget = resolveAnimationTarget({
						element: target.element,
						path: operation.propertyPath,
					});
					if (
						animationTarget &&
						animationTarget.coerceValue({
							value: operation.value as ParamValue,
						}) === null
					) {
						errors.push(
							`upsert_keyframe value is invalid for ${operation.propertyPath}`,
						);
					}
				}

				if (
					operation.type === "remove_keyframe" &&
					!element.keyframes?.some(
						(keyframe) =>
							keyframe.propertyPath === operation.propertyPath &&
							keyframe.keyframeId === operation.keyframeId,
					)
				) {
					errors.push(
						`remove_keyframe references a missing keyframe ${operation.keyframeId}`,
					);
				}
			}
		}

		if (
			range &&
			operation.type === "attach_custom_edit" &&
			operation.startTime !== undefined &&
			operation.duration !== undefined &&
			(operation.startTime < range.startTime ||
				operation.startTime + operation.duration > range.endTime)
		) {
			errors.push("attach_custom_edit timing is outside the selected range");
		}
		if (
			range &&
			operation.type === "split_element" &&
			(operation.splitTime < range.startTime ||
				operation.splitTime > range.endTime)
		) {
			errors.push("split_element splitTime is outside the selected range");
		}
	}

	return errors;
}

function getTimelineSourceV2OperationErrors({
	operation,
	range,
	mediaAssets,
	scenes,
	activeSceneId,
	projectSettings,
	timelineSourceV2ScopeValidator,
}: {
	operation: Extract<AiEditOperation, { type: "apply_timeline_source_v2" }>;
	range?: AiTimelineRange | null;
	mediaAssets?: MediaAsset[];
	scenes?: TScene[];
	activeSceneId?: string;
	projectSettings?: TProjectSettings;
	timelineSourceV2ScopeValidator?: TimelineDocumentV2MutationScopeValidator;
}): string[] {
	const errors: string[] = [];
	const activeScene = scenes?.find((scene) => scene.id === activeSceneId);
	if (!activeScene || !projectSettings) {
		return [
			"apply_timeline_source_v2 requires active scene and project context",
		];
	}

	const currentDocument = buildTimelineDocumentV2({
		project: { settings: projectSettings },
		scene: activeScene,
	});
	if (!currentDocument.valid) {
		return currentDocument.diagnostics.map(
			(diagnostic) =>
				`Current Timeline Source ${diagnostic.path}: ${diagnostic.message}`,
		);
	}
	if (operation.baseRevision !== currentDocument.baseRevision) {
		errors.push(
			"apply_timeline_source_v2 is stale because the timeline changed after the source was read",
		);
	}

	const before = parseTimelineDocumentV2({
		text: currentDocument.formattedText,
	});
	const after = parseTimelineDocumentV2({ text: operation.document });
	if (!before.valid || !before.value) {
		errors.push(
			...before.diagnostics.map(
				(diagnostic) =>
					`Current Timeline Source ${diagnostic.path}: ${diagnostic.message}`,
			),
		);
		return errors;
	}
	if (!after.valid || !after.value) {
		errors.push(
			...after.diagnostics.map(
				(diagnostic) =>
					`Edited Timeline Source ${diagnostic.path}: ${diagnostic.message}`,
			),
		);
		return errors;
	}
	if (after.baseRevision === currentDocument.baseRevision) {
		errors.push("apply_timeline_source_v2 makes no persistent timeline change");
	}

	if (
		range &&
		(!operation.scope ||
			operation.scope.startTime !== range.startTime ||
			operation.scope.endTime !== range.endTime)
	) {
		errors.push(
			"apply_timeline_source_v2 scope does not match the active selected range",
		);
	}
	const selectedScope = range ?? operation.scope ?? null;
	const scopeValidation = validateTimelineDocumentV2MutationScope({
		before: before.value,
		after: after.value,
		selectedRange: selectedScope
			? {
					startTime: selectedScope.startTime,
					duration: mediaTime({
						ticks: Math.max(0, selectedScope.endTime - selectedScope.startTime),
					}),
				}
			: null,
		validate: timelineSourceV2ScopeValidator,
	});
	errors.push(
		...scopeValidation.diagnostics.map(
			(diagnostic) => `${diagnostic.path}: ${diagnostic.message}`,
		),
	);

	if (mediaAssets) {
		const mediaIds = new Set(mediaAssets.map((asset) => asset.id));
		for (const track of getDisplayTracks(after.value.tracks)) {
			for (const element of track.elements) {
				const mediaId =
					element.type === "video" || element.type === "image"
						? element.mediaId
						: element.type === "audio" && element.sourceType === "upload"
							? element.mediaId
							: null;
				if (mediaId && !mediaIds.has(mediaId)) {
					errors.push(
						`Edited Timeline Source references missing media asset ${mediaId}`,
					);
				}
			}
		}
	}

	return [...new Set(errors)];
}

function findTrackAndElement({
	tracks,
	trackId,
	elementId,
}: {
	tracks: ReturnType<typeof getDisplayTracks>;
	trackId: string;
	elementId: string;
}): {
	track: ReturnType<typeof getDisplayTracks>[number];
	element: TimelineElement;
} | null {
	const track = tracks.find((candidate) => candidate.id === trackId);
	const element = track?.elements.find(
		(candidate) => candidate.id === elementId,
	);
	return track && element ? { track, element } : null;
}

function getOperationElementRefs(
	operation: AiEditOperation,
): Array<{ trackId: string; elementId: string }> {
	switch (operation.type) {
		case "apply_timeline_source_v2":
		case "insert_text_element":
		case "insert_media_element":
		case "insert_library_audio_element":
		case "insert_graphic_element":
		case "insert_html_element":
		case "insert_sticker_element":
		case "insert_effect_element":
		case "add_track":
		case "remove_track":
		case "reorder_track":
		case "set_track_state":
		case "create_scene":
		case "rename_scene":
		case "delete_scene":
		case "set_project_settings":
		case "add_bookmark":
		case "update_bookmark":
		case "remove_bookmark":
		case "move_bookmark":
		case "start_export_task":
		case "start_transcription_task":
			return [];
		case "move_element":
			return [
				{ trackId: operation.sourceTrackId, elementId: operation.elementId },
			];
		default:
			return [{ trackId: operation.trackId, elementId: operation.elementId }];
	}
}

function getInsertOperationErrors({
	operation,
	index,
	displayTracks,
	range,
	mediaAssets,
}: {
	operation: Extract<
		AiEditOperation,
		{
			type:
				| "insert_media_element"
				| "insert_library_audio_element"
				| "insert_graphic_element"
				| "insert_html_element"
				| "insert_sticker_element"
				| "insert_effect_element";
		}
	>;
	index: ReturnType<typeof buildTimelineContextIndex>;
	displayTracks: ReturnType<typeof getDisplayTracks>;
	range?: AiTimelineRange | null;
	mediaAssets?: MediaAsset[];
}): string[] {
	const errors: string[] = [];

	let mediaAsset: MediaAsset | undefined;
	if (operation.type === "insert_media_element") {
		mediaAsset = mediaAssets?.find((asset) => asset.id === operation.mediaId);
		if (mediaAssets && !mediaAsset) {
			errors.push(
				`insert_media_element references a missing media asset ${operation.mediaId}`,
			);
		}
	}

	if (operation.type === "insert_graphic_element") {
		registerDefaultGraphics();
		if (!graphicsRegistry.has(operation.definitionId)) {
			errors.push(
				`insert_graphic_element references an unknown graphic definition ${operation.definitionId}`,
			);
		}
	}

	if (operation.type === "insert_html_element" && !operation.html.trim()) {
		errors.push("insert_html_element requires non-empty html");
	}
	if (operation.type === "insert_effect_element") {
		registerDefaultEffects();
		if (!effectsRegistry.has(operation.effectType)) {
			errors.push(
				`insert_effect_element references an unknown effect definition ${operation.effectType}`,
			);
		}
	}

	if (operation.trackId) {
		const layer = index.layersById.get(operation.trackId);
		const track = displayTracks.find(
			(candidate) => candidate.id === operation.trackId,
		);
		if (!layer || !track) {
			errors.push(
				`${operation.type} references a missing track ${operation.trackId}`,
			);
		} else {
			const element = buildElementForInsertOperation({
				operation,
				mediaAsset,
			});
			if (element) {
				const validation = validateElementTrackCompatibility({
					element: element as TimelineElement,
					track,
				});
				if (!validation.isValid) {
					errors.push(
						validation.errorMessage ??
							`${operation.type} cannot target track ${operation.trackId}`,
					);
				}
			}
		}
	}

	if (range) {
		const duration =
			operation.type === "insert_media_element"
				? (operation.duration ??
					(mediaAsset
						? getMediaAssetDefaultDuration({ mediaAsset })
						: (0 as MediaTime)))
				: operation.duration;
		const endTime = operation.startTime + (duration ?? 0);
		if (operation.startTime < range.startTime || endTime > range.endTime) {
			errors.push(`${operation.type} is outside the selected range`);
		}
	}

	return errors;
}

function getMediaAssetDefaultDuration({
	mediaAsset,
}: {
	mediaAsset: MediaAsset;
}): MediaTime {
	if (mediaAsset.duration && mediaAsset.duration > 0) {
		return mediaTimeFromSeconds({ seconds: mediaAsset.duration });
	}
	return DEFAULT_NEW_ELEMENT_DURATION;
}

function buildElementForInsertOperation({
	operation,
	mediaAsset,
}: {
	operation: Extract<
		AiEditOperation,
		{
			type:
				| "insert_media_element"
				| "insert_library_audio_element"
				| "insert_graphic_element"
				| "insert_html_element"
				| "insert_sticker_element"
				| "insert_effect_element";
		}
	>;
	mediaAsset?: MediaAsset;
}): CreateTimelineElement | null {
	if (operation.type === "insert_media_element") {
		if (!mediaAsset) {
			return null;
		}
		const element = buildElementFromMedia({
			mediaId: mediaAsset.id,
			mediaType: mediaAsset.type,
			name: operation.name ?? mediaAsset.name,
			duration:
				operation.duration ?? getMediaAssetDefaultDuration({ mediaAsset }),
			startTime: operation.startTime,
		});
		return element;
	}
	if (operation.type === "insert_library_audio_element") {
		return buildLibraryAudioElement({
			libraryAssetId: operation.libraryAssetId,
			librarySourceType: "shared",
			name: operation.name,
			duration: operation.duration,
			startTime: operation.startTime,
		});
	}

	if (operation.type === "insert_graphic_element") {
		const element = buildGraphicElement({
			definitionId: operation.definitionId,
			name: operation.name,
			startTime: operation.startTime,
			params: operation.params,
		});
		return { ...element, duration: operation.duration };
	}
	if (operation.type === "insert_sticker_element") {
		const element = buildStickerElement({
			stickerId: operation.stickerId,
			name: operation.name,
			startTime: operation.startTime,
			intrinsicWidth: operation.intrinsicWidth,
			intrinsicHeight: operation.intrinsicHeight,
		});
		return {
			...element,
			duration: operation.duration,
			params: { ...element.params, ...(operation.params ?? {}) },
		};
	}
	if (operation.type === "insert_effect_element") {
		return buildEffectElement({
			effectType: operation.effectType,
			startTime: operation.startTime,
			duration: operation.duration,
			name: operation.name,
			params: operation.params,
		});
	}

	const element = buildGraphicElement({
		definitionId: HYPERFRAME_DEFINITION_ID,
		name: operation.name ?? "AI HTML frame",
		startTime: operation.startTime,
		params: {
			...(operation.params ?? {}),
			html: operation.html,
			sourceWidth: operation.sourceWidth ?? DEFAULT_HYPERFRAME_WIDTH,
			sourceHeight: operation.sourceHeight ?? DEFAULT_HYPERFRAME_HEIGHT,
		},
	});
	return { ...element, duration: operation.duration };
}

function applyOperation({
	editor,
	operation,
	timelineSourceV2ScopeValidator,
}: {
	editor: EditorCore;
	operation: AiEditOperation;
	timelineSourceV2ScopeValidator?: TimelineDocumentV2MutationScopeValidator;
}): void {
	switch (operation.type) {
		case "apply_timeline_source_v2": {
			const currentScene = editor.scenes.getActiveSceneOrNull();
			if (!currentScene) throw new Error("No active scene");
			const currentProject = editor.project.getActive();
			const currentDocument = buildTimelineDocumentV2({
				project: currentProject,
				scene: currentScene,
			});
			if (!currentDocument.valid) {
				throw new Error(
					`Current Timeline Source is invalid: ${currentDocument.diagnostics
						.map((diagnostic) => diagnostic.message)
						.join("; ")}`,
				);
			}
			if (currentDocument.baseRevision !== operation.baseRevision) {
				throw new Error(
					"Timeline Source is stale because the timeline changed before apply",
				);
			}
			const before = parseTimelineDocumentV2({
				text: currentDocument.formattedText,
			});
			const after = parseTimelineDocumentV2({ text: operation.document });
			if (!before.valid || !before.value || !after.valid || !after.value) {
				const diagnostics = [...before.diagnostics, ...after.diagnostics];
				throw new Error(
					`Edited Timeline Source is invalid: ${diagnostics
						.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
						.join("; ")}`,
				);
			}
			if (after.baseRevision === currentDocument.baseRevision) {
				throw new Error("Timeline Source makes no persistent timeline change");
			}
			const scopeValidation = validateTimelineDocumentV2MutationScope({
				before: before.value,
				after: after.value,
				selectedRange: operation.scope
					? {
							startTime: operation.scope.startTime,
							duration: mediaTime({
								ticks: Math.max(
									0,
									operation.scope.endTime - operation.scope.startTime,
								),
							}),
						}
					: null,
				validate: timelineSourceV2ScopeValidator,
			});
			if (!scopeValidation.valid) {
				throw new Error(
					`Edited Timeline Source is outside its scope: ${scopeValidation.diagnostics
						.map((diagnostic) => diagnostic.message)
						.join("; ")}`,
				);
			}

			const value = after.value;
			const scenes = updateSceneInArray({
				scenes: editor.scenes.getScenes(),
				sceneId: currentScene.id,
				updates: {
					name: value.scene.name,
					createdAt: value.scene.createdAt,
					updatedAt: value.scene.updatedAt,
					tracks: value.tracks,
					bookmarks: value.bookmarks,
				},
			});
			editor.scenes.setScenes({
				scenes,
				activeSceneId: currentScene.id,
			});
			const project = editor.project.getActive();
			editor.project.setActiveProject({
				project: {
					...project,
					settings: value.projectSettings,
					metadata: { ...project.metadata, updatedAt: new Date() },
				},
			});
			editor.save.markDirty();
			return;
		}
		case "insert_text_element":
			editor.timeline.insertElement({
				element: buildInsertedTextElement({ operation }),
				placement: operation.trackId
					? { mode: "explicit", trackId: operation.trackId }
					: { mode: "auto", trackType: "text" },
			});
			return;
		case "update_element":
			editor.timeline.updateElements({
				updates: [
					{
						trackId: operation.trackId,
						elementId: operation.elementId,
						patch: operation.patch,
					},
				],
			});
			return;
		case "trim_element":
			{
				const track = editor.timeline.getTrackById({
					trackId: operation.trackId,
				});
				const element = track?.elements.find(
					(candidate) => candidate.id === operation.elementId,
				);
				if (!element) return;
				editor.timeline.updateElementTrim({
					elementId: operation.elementId,
					trimStart: operation.trimStart ?? element.trimStart,
					trimEnd: operation.trimEnd ?? element.trimEnd,
					startTime: operation.startTime,
					duration: operation.duration,
				});
			}
			return;
		case "move_element":
			editor.timeline.moveElements({
				moves: [
					{
						sourceTrackId: operation.sourceTrackId,
						targetTrackId: operation.targetTrackId,
						elementId: operation.elementId,
						newStartTime: operation.startTime,
					},
				],
			});
			return;
		case "split_element":
			editor.timeline.splitElements({
				elements: [
					{ trackId: operation.trackId, elementId: operation.elementId },
				],
				splitTime: operation.splitTime,
				retainSide: operation.retainSide ?? "both",
			});
			return;
		case "delete_element":
			editor.timeline.deleteElements({
				elements: [
					{ trackId: operation.trackId, elementId: operation.elementId },
				],
			});
			return;
		case "add_clip_effect":
			editor.timeline.addClipEffect({
				trackId: operation.trackId,
				elementId: operation.elementId,
				effectType: operation.effectType,
				params: operation.params,
			});
			return;
		case "attach_custom_edit":
			{
				const target = getOperationTargetElement({ editor, operation });
				if (!target) return;
				editor.timeline.insertElement({
					element: buildCustomEditEffectElement({ operation, target }),
					placement: { mode: "auto", trackType: "effect" },
				});
			}
			return;
		case "update_clip_effect_params":
			editor.timeline.updateClipEffectParams({
				trackId: operation.trackId,
				elementId: operation.elementId,
				effectId: operation.effectId,
				params: operation.params,
			});
			return;
		case "remove_clip_effect":
			editor.timeline.removeClipEffect({
				trackId: operation.trackId,
				elementId: operation.elementId,
				effectId: operation.effectId,
			});
			return;
		case "set_clip_effect_enabled":
			{
				const target = editor.timeline
					.getTrackById({ trackId: operation.trackId })
					?.elements.find((element) => element.id === operation.elementId);
				const effect =
					target && "effects" in target
						? target.effects?.find(
								(candidate) => candidate.id === operation.effectId,
							)
						: undefined;
				if (effect && effect.enabled !== operation.enabled) {
					editor.timeline.toggleClipEffect({
						trackId: operation.trackId,
						elementId: operation.elementId,
						effectId: operation.effectId,
					});
				}
			}
			return;
		case "reorder_clip_effect":
			editor.timeline.reorderClipEffects({
				trackId: operation.trackId,
				elementId: operation.elementId,
				fromIndex: operation.fromIndex,
				toIndex: operation.toIndex,
			});
			return;
		case "set_background_removal":
			{
				const target = editor.timeline
					.getTrackById({ trackId: operation.trackId })
					?.elements.find((element) => element.id === operation.elementId);
				if (!target || target.type !== "video") return;
				const defaults = getDefaultBackgroundRemovalSettings();
				editor.timeline.setBackgroundRemoval({
					trackId: operation.trackId,
					elementId: operation.elementId,
					duplicate: operation.duplicate ?? false,
					settings: {
						...defaults,
						...(target.backgroundRemoval ?? {}),
						enabled: operation.enabled,
						...(operation.mode ? { mode: operation.mode } : {}),
						...(operation.quality ? { quality: operation.quality } : {}),
						...(operation.maskThreshold !== undefined
							? { maskThreshold: operation.maskThreshold }
							: {}),
						...(operation.edgeContrast !== undefined
							? { edgeContrast: operation.edgeContrast }
							: {}),
						...(operation.edgeFeather !== undefined
							? { edgeFeather: operation.edgeFeather }
							: {}),
						...(operation.temporalSmoothing !== undefined
							? { temporalSmoothing: operation.temporalSmoothing }
							: {}),
						...(operation.blurStrength !== undefined
							? { blurStrength: operation.blurStrength }
							: {}),
					},
				});
			}
			return;
		case "upsert_keyframe":
			editor.timeline.upsertKeyframes({
				keyframes: [
					{
						trackId: operation.trackId,
						elementId: operation.elementId,
						propertyPath: operation.propertyPath as AnimationPath,
						time: operation.time,
						value: operation.value as ParamValue,
						interpolation: operation.interpolation,
						keyframeId: operation.keyframeId,
					},
				],
			});
			return;
		case "remove_keyframe":
			editor.timeline.removeKeyframes({
				keyframes: [
					{
						trackId: operation.trackId,
						elementId: operation.elementId,
						propertyPath: operation.propertyPath as AnimationPath,
						keyframeId: operation.keyframeId,
					},
				],
			});
			return;
		case "add_track":
			editor.timeline.addTrack({
				type: operation.trackType,
				index: operation.index,
			});
			return;
		case "remove_track":
			editor.timeline.removeTrack({ trackId: operation.trackId });
			return;
		case "reorder_track":
			editor.timeline.reorderTrack({
				trackId: operation.trackId,
				toIndex: operation.toIndex,
			});
			return;
		case "set_track_state":
			{
				const track = editor.timeline.getTrackById({
					trackId: operation.trackId,
				});
				if (!track) return;
				if (
					operation.muted !== undefined &&
					"muted" in track &&
					track.muted !== operation.muted
				) {
					editor.timeline.toggleTrackMute({ trackId: operation.trackId });
				}
				if (
					operation.hidden !== undefined &&
					"hidden" in track &&
					track.hidden !== operation.hidden
				) {
					editor.timeline.toggleTrackVisibility({
						trackId: operation.trackId,
					});
				}
			}
			return;
		case "create_scene":
			editor.scenes.setScenes({
				scenes: [
					...editor.scenes.getScenes(),
					buildDefaultScene({ name: operation.name, isMain: false }),
				],
			});
			editor.save.markDirty();
			return;
		case "rename_scene": {
			const scenes = editor.scenes.getScenes();
			editor.scenes.setScenes({
				scenes: updateSceneInArray({
					scenes,
					sceneId: operation.sceneId,
					updates: { name: operation.name, updatedAt: new Date() },
				}),
			});
			editor.save.markDirty();
			return;
		}
		case "delete_scene": {
			const scenes = editor.scenes.getScenes();
			const activeSceneId = editor.scenes.getActiveSceneOrNull()?.id ?? null;
			const updatedScenes = scenes.filter(
				(scene) => scene.id !== operation.sceneId,
			);
			const fallback = getFallbackSceneAfterDelete({
				scenes: updatedScenes,
				deletedSceneId: operation.sceneId,
				currentSceneId: activeSceneId,
			});
			editor.scenes.setScenes({
				scenes: updatedScenes,
				activeSceneId: fallback?.id,
			});
			editor.save.markDirty();
			return;
		}
		case "set_project_settings": {
			const project = editor.project.getActive();
			const updates: Partial<TProjectSettings> = {};
			if (operation.fps) updates.fps = operation.fps;
			if (operation.canvasSize) {
				updates.canvasSize = operation.canvasSize;
				updates.canvasSizeMode = "custom";
				updates.lastCustomCanvasSize = operation.canvasSize;
			}
			if (operation.background) updates.background = operation.background;
			editor.project.setActiveProject({
				project: {
					...project,
					settings: { ...project.settings, ...updates },
					metadata: { ...project.metadata, updatedAt: new Date() },
				},
			});
			editor.save.markDirty();
			return;
		}
		case "add_bookmark": {
			const activeScene = editor.scenes.getActiveSceneOrNull();
			const project = editor.project.getActive();
			if (!activeScene) return;
			const time = getFrameTime({
				time: operation.time,
				fps: project.settings.fps,
			});
			setActiveSceneBookmarks({
				editor,
				bookmarks: [
					...activeScene.bookmarks,
					{
						time,
						...(operation.note !== undefined ? { note: operation.note } : {}),
						...(operation.color !== undefined
							? { color: operation.color }
							: {}),
						...(operation.duration !== undefined
							? { duration: operation.duration }
							: {}),
					},
				].sort((left, right) => left.time - right.time),
			});
			return;
		}
		case "update_bookmark": {
			const activeScene = editor.scenes.getActiveSceneOrNull();
			const project = editor.project.getActive();
			if (!activeScene) return;
			const frameTime = getFrameTime({
				time: operation.time,
				fps: project.settings.fps,
			});
			setActiveSceneBookmarks({
				editor,
				bookmarks: updateBookmarkInArray({
					bookmarks: activeScene.bookmarks,
					frameTime,
					updates: {
						...(operation.note !== undefined ? { note: operation.note } : {}),
						...(operation.color !== undefined
							? { color: operation.color }
							: {}),
						...(operation.duration !== undefined
							? { duration: operation.duration }
							: {}),
					},
				}),
			});
			return;
		}
		case "remove_bookmark": {
			const activeScene = editor.scenes.getActiveSceneOrNull();
			const project = editor.project.getActive();
			if (!activeScene) return;
			const frameTime = getFrameTime({
				time: operation.time,
				fps: project.settings.fps,
			});
			setActiveSceneBookmarks({
				editor,
				bookmarks: removeBookmarkFromArray({
					bookmarks: activeScene.bookmarks,
					frameTime,
				}),
			});
			return;
		}
		case "move_bookmark": {
			const activeScene = editor.scenes.getActiveSceneOrNull();
			const project = editor.project.getActive();
			if (!activeScene) return;
			setActiveSceneBookmarks({
				editor,
				bookmarks: moveBookmarkInArray({
					bookmarks: activeScene.bookmarks,
					fromTime: getFrameTime({
						time: operation.fromTime,
						fps: project.settings.fps,
					}),
					toTime: getFrameTime({
						time: operation.toTime,
						fps: project.settings.fps,
					}),
				}),
			});
			return;
		}
		case "start_export_task":
			throw new Error(
				"start_export_task must be handled as a standalone reviewed task",
			);
		case "start_transcription_task":
			throw new Error(
				"start_transcription_task must be handled as a standalone reviewed task",
			);
		case "insert_media_element":
			{
				const mediaAsset = editor.media
					.getAssets()
					.find((asset) => asset.id === operation.mediaId);
				const element = buildElementForInsertOperation({
					operation,
					mediaAsset,
				});
				if (!element) {
					throw new Error(
						`Media asset ${operation.mediaId} was not found in the project`,
					);
				}
				editor.timeline.insertElement({
					element,
					placement: operation.trackId
						? { mode: "explicit", trackId: operation.trackId }
						: {
								mode: "auto",
								trackType: element.type === "audio" ? "audio" : "video",
							},
				});
			}
			return;
		case "insert_library_audio_element":
			{
				const element = buildElementForInsertOperation({ operation });
				if (!element) return;
				editor.timeline.insertElement({
					element,
					placement: operation.trackId
						? { mode: "explicit", trackId: operation.trackId }
						: { mode: "auto", trackType: "audio" },
				});
			}
			return;
		case "insert_graphic_element":
		case "insert_html_element":
			{
				const element = buildElementForInsertOperation({ operation });
				if (!element) return;
				editor.timeline.insertElement({
					element,
					placement: operation.trackId
						? { mode: "explicit", trackId: operation.trackId }
						: { mode: "auto" },
				});
			}
			return;
		case "insert_sticker_element":
		case "insert_effect_element":
			{
				const element = buildElementForInsertOperation({ operation });
				if (!element) return;
				editor.timeline.insertElement({
					element,
					placement: operation.trackId
						? { mode: "explicit", trackId: operation.trackId }
						: {
								mode: "auto",
								trackType: element.type === "effect" ? "effect" : "graphic",
							},
				});
			}
			return;
		case "duplicate_element":
			editor.timeline.duplicateElements({
				elements: [
					{ trackId: operation.trackId, elementId: operation.elementId },
				],
			});
			return;
		case "apply_transition":
			editor.timeline.applyTransitions({
				applications: [
					{
						trackId: operation.trackId,
						elementId: operation.elementId,
						presetId: operation.presetId,
						side: operation.side,
						percent: operation.percent,
					},
				],
			});
			return;
		case "set_element_state":
			{
				const target = editor.timeline
					.getTrackById({ trackId: operation.trackId })
					?.elements.find((element) => element.id === operation.elementId);
				if (!target) return;
				const refs = [
					{ trackId: operation.trackId, elementId: operation.elementId },
				];
				if (
					operation.hidden !== undefined &&
					"hidden" in target &&
					Boolean(target.hidden) !== operation.hidden
				) {
					editor.timeline.toggleElementsVisibility({ elements: refs });
				}
				if (
					operation.muted !== undefined &&
					Boolean(target.params.muted) !== operation.muted
				) {
					editor.timeline.toggleElementsMuted({ elements: refs });
				}
			}
			return;
		case "retime_element":
			editor.timeline.updateElementRetime({
				trackId: operation.trackId,
				elementId: operation.elementId,
				retime: {
					rate: operation.rate,
					maintainPitch: operation.maintainPitch,
				},
			});
			return;
		default: {
			const exhaustive: never = operation;
			return exhaustive;
		}
	}
}

function setActiveSceneBookmarks({
	editor,
	bookmarks,
}: {
	editor: EditorCore;
	bookmarks: TScene["bookmarks"];
}): void {
	const activeScene = editor.scenes.getActiveSceneOrNull();
	if (!activeScene) return;
	editor.scenes.setScenes({
		scenes: updateSceneInArray({
			scenes: editor.scenes.getScenes(),
			sceneId: activeScene.id,
			updates: { bookmarks, updatedAt: new Date() },
		}),
	});
	editor.save.markDirty();
}

function getOperationTargetElement({
	editor,
	operation,
}: {
	editor: EditorCore;
	operation: Extract<
		AiEditOperation,
		{
			type:
				| "add_clip_effect"
				| "attach_custom_edit"
				| "update_clip_effect_params";
		}
	>;
}) {
	const track = editor.timeline.getTrackById({ trackId: operation.trackId });
	return track?.elements.find((element) => element.id === operation.elementId);
}

export function buildCustomEditEffectElement({
	operation,
	target,
}: {
	operation: Extract<AiEditOperation, { type: "attach_custom_edit" }>;
	target: Pick<TimelineElement, "startTime" | "duration">;
}) {
	return buildEffectElement({
		effectType: CUSTOM_AI_EFFECT_TYPE,
		name: `AI: ${operation.label}`,
		startTime: operation.startTime ?? target.startTime,
		duration: operation.duration ?? target.duration,
		params: buildCustomEditEffectParams({ operation }),
	});
}

export function buildCustomEditEffectParams({
	operation,
}: {
	operation: Extract<AiEditOperation, { type: "attach_custom_edit" }>;
}): ReturnType<typeof buildCustomAiEffectParams> {
	return buildCustomAiEffectParams({
		requestedType: operation.label,
		label: operation.label,
		kind: operation.kind,
		intent: operation.intent ?? operation.reason,
		spec: {
			host: {
				type: "effect-layer",
				target: {
					trackId: operation.trackId,
					elementId: operation.elementId,
				},
				timing:
					operation.startTime !== undefined && operation.duration !== undefined
						? {
								startTime: operation.startTime,
								duration: operation.duration,
							}
						: null,
			},
			kind: operation.kind ?? "effect",
			intent: operation.intent ?? operation.reason ?? operation.label,
			label: operation.label,
			spec: operation.spec,
		},
	});
}

function isClipEffectOperation(operation: AiEditOperation): boolean {
	return (
		operation.type === "add_clip_effect" ||
		operation.type === "attach_custom_edit" ||
		operation.type === "update_clip_effect_params" ||
		operation.type === "remove_clip_effect" ||
		operation.type === "set_clip_effect_enabled" ||
		operation.type === "reorder_clip_effect"
	);
}

function getReferencedEffectId(operation: AiEditOperation): string | null {
	return operation.type === "update_clip_effect_params" ||
		operation.type === "remove_clip_effect" ||
		operation.type === "set_clip_effect_enabled"
		? operation.effectId
		: null;
}

function isVisualElementType({ type }: { type: ElementType }): boolean {
	return VISUAL_ELEMENT_TYPES.some((candidate) => candidate === type);
}

function buildInsertedTextElement({
	operation,
}: {
	operation: Extract<AiEditOperation, { type: "insert_text_element" }>;
}): CreateTextElement {
	const fallbackName = operation.content.trim().slice(0, 40) || "AI text";

	return {
		...DEFAULTS.text.element,
		name: operation.name?.trim() || fallbackName,
		startTime: operation.startTime,
		duration: operation.duration,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			...DEFAULTS.text.element.params,
			content: operation.content,
			...(operation.params ?? {}),
		},
	};
}
