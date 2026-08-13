import { z } from "zod";
import { BACKGROUND_PRESETS } from "@/backgrounds/presets";
import {
	buildCustomAiEffectParams,
	CUSTOM_AI_EFFECT_TYPE,
} from "@/effects/custom-ai-effect";
import type {
	GeneratedBackgroundPreset,
	GeneratedEffectPreset,
	GeneratedUiElementPreset,
} from "@/shared-library";

const HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const BACKGROUND_STYLES = BACKGROUND_PRESETS.map((preset) =>
	String(preset.params.preset ?? preset.id),
);
const EFFECT_TEMPLATES = [
	"blur",
	"tint",
	"color-wash",
	"vignette",
	"pixelate",
	"rgb-split",
	"chromatic-shift",
	"scanlines",
	"noise",
] as const;
const MINIMAL_PRODUCT_UI_TEMPLATES = [
	"minimal-note",
	"search-bar",
	"goal-slider",
	"metric-pill",
	"avatar-message-left",
	"avatar-message-right",
	"folder-pill",
	"profile-stack",
	"app-notification",
] as const;
const UI_ELEMENT_CATEGORIES = [
	"communication",
	"metrics",
	"social",
	"status",
	"workflow",
] as const;

const backgroundPresetSchema = z
	.object({
		name: z.string().trim().min(1).max(60),
		description: z.string().trim().min(1).max(120),
		params: z
			.object({
				preset: z.string().refine((value) => BACKGROUND_STYLES.includes(value)),
				colorA: z.string().regex(HEX_COLOR),
				colorB: z.string().regex(HEX_COLOR),
				colorC: z.string().regex(HEX_COLOR),
				density: z.number().min(1).max(100),
				intensity: z.number().min(0).max(100),
				scale: z.number().min(1).max(100),
				seed: z.number().int().min(1).max(99),
			})
			.strict(),
	})
	.strict();

const effectPresetSchema = z
	.object({
		name: z.string().trim().min(1).max(60),
		description: z.string().trim().min(1).max(120),
		template: z.enum(EFFECT_TEMPLATES),
		intensity: z.number().min(0).max(100),
		color: z.string().regex(HEX_COLOR).optional(),
	})
	.strict();

const uiElementPresetSchema = z
	.object({
		name: z.string().trim().min(1).max(60),
		description: z.string().trim().min(1).max(120),
		category: z.enum(UI_ELEMENT_CATEGORIES),
		keywords: z.array(z.string().trim().min(1).max(30)).min(3).max(10),
		whenToUse: z.string().trim().min(1).max(160),
		template: z.enum(MINIMAL_PRODUCT_UI_TEMPLATES),
		label: z.string().trim().max(80),
		secondary: z.string().trim().max(80),
		items: z.array(z.string().trim().min(1).max(60)).max(8),
		accent: z.string().regex(HEX_COLOR),
		background: z.string().regex(HEX_COLOR),
		foreground: z.string().regex(HEX_COLOR),
		progress: z.number().min(0).max(100),
		count: z.number().int().min(0).max(1_000_000),
		intensity: z.number().min(0).max(100),
		defaultDurationSeconds: z.number().min(1).max(8),
		animationStyle: z.enum(["soft", "precise", "energetic"]),
		animationInEnd: z.number().min(8).max(45),
		animationOutStart: z.number().min(60).max(95),
		animationStrength: z.number().min(40).max(160),
		eventAt: z.number().min(20).max(85),
	})
	.strict();

const UI_ELEMENT_MOTION: Record<
	(typeof MINIMAL_PRODUCT_UI_TEMPLATES)[number],
	{ animationIn: string; animationOut: string }
> = {
	"minimal-note": {
		animationIn: "card-glass-unfold",
		animationOut: "card-panel-drop",
	},
	"search-bar": {
		animationIn: "card-window-open",
		animationOut: "card-window-close",
	},
	"goal-slider": {
		animationIn: "progress-meter-sweep",
		animationOut: "progress-complete-flash",
	},
	"metric-pill": {
		animationIn: "counter-count-up",
		animationOut: "counter-metric-dim",
	},
	"avatar-message-left": {
		animationIn: "chat-slide-thread",
		animationOut: "chat-slide-away",
	},
	"avatar-message-right": {
		animationIn: "chat-glow-reply",
		animationOut: "chat-soft-fold",
	},
	"folder-pill": {
		animationIn: "card-panel-rise",
		animationOut: "card-panel-drop",
	},
	"profile-stack": {
		animationIn: "card-social-slide",
		animationOut: "card-social-swipe",
	},
	"app-notification": {
		animationIn: "chat-notification-drop",
		animationOut: "chat-notification-swipe",
	},
};

type ResponsesApiResult = {
	output_text?: string;
	output?: Array<{
		content?: Array<{ text?: string; output_text?: string }>;
	}>;
	error?: { message?: string };
};

function getResponseText(response: ResponsesApiResult): string {
	if (typeof response.output_text === "string") {
		return response.output_text;
	}

	return (response.output ?? [])
		.flatMap((item) => item.content ?? [])
		.map((content) => content.text ?? content.output_text ?? "")
		.filter(Boolean)
		.join("\n")
		.trim();
}

function extractJsonObject({ text }: { text: string }): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const raw = fenced?.[1] ?? text;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new Error("AI response did not contain JSON");
	}
	return JSON.parse(raw.slice(start, end + 1));
}

async function requestPresetJson({
	system,
	prompt,
}: {
	system: string;
	prompt: string;
}): Promise<unknown> {
	const response = await fetch("/api/ai/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			input: [
				{ role: "system", content: system },
				{ role: "user", content: prompt },
			],
		}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(
			typeof data.error === "string"
				? data.error
				: `AI request failed (${response.status})`,
		);
	}
	if (!data.response) {
		throw new Error("AI response was empty");
	}
	const aiResponse = data.response as ResponsesApiResult;
	if (aiResponse.error?.message) {
		throw new Error(aiResponse.error.message);
	}
	return extractJsonObject({ text: getResponseText(aiResponse) });
}

export async function generateBackgroundPreset({
	prompt,
}: {
	prompt: string;
}): Promise<Omit<GeneratedBackgroundPreset, "id" | "createdAt" | "updatedAt">> {
	const value = await requestPresetJson({
		system: [
			"You create OpenCut preset-background JSON only.",
			"Return one JSON object with name, description, and params.",
			`params.preset must be one of: ${BACKGROUND_STYLES.join(", ")}.`,
			"Use only hex colors and numeric density/intensity/scale/seed values.",
		].join("\n"),
		prompt,
	});
	const parsed = backgroundPresetSchema.parse(value);
	return {
		name: parsed.name,
		description: parsed.description,
		params: {
			presetId: `ai-${Date.now()}`,
			...parsed.params,
		},
	};
}

export async function generateEffectPreset({
	prompt,
}: {
	prompt: string;
}): Promise<Omit<GeneratedEffectPreset, "id" | "createdAt" | "updatedAt">> {
	const value = await requestPresetJson({
		system: [
			"You create OpenCut effect preset JSON only.",
			"Return one JSON object with name, description, template, intensity, and optional color.",
			`template must be one of: ${EFFECT_TEMPLATES.join(", ")}.`,
			"Do not create external images or videos.",
		].join("\n"),
		prompt,
	});
	const parsed = effectPresetSchema.parse(value);
	if (parsed.template === "blur") {
		return {
			name: parsed.name,
			description: parsed.description,
			effectType: "blur",
			params: { intensity: parsed.intensity },
		};
	}

	return {
		name: parsed.name,
		description: parsed.description,
		effectType: CUSTOM_AI_EFFECT_TYPE,
		params: buildCustomAiEffectParams({
			requestedType: parsed.template,
			label: parsed.name,
			kind: "effect",
			intent: prompt,
			spec: {
				template: parsed.template,
				intensity: parsed.intensity,
				color: parsed.color,
			},
		}),
	};
}

export async function generateUiElementPreset({
	prompt,
}: {
	prompt: string;
}): Promise<Omit<GeneratedUiElementPreset, "id" | "createdAt" | "updatedAt">> {
	const value = await requestPresetJson({
		system: [
			"You create one reusable OpenCut minimal product-UI motion asset as JSON only.",
			"Return name, description, category, keywords, whenToUse, template, label, secondary, items, accent, background, foreground, progress, count, intensity, defaultDurationSeconds, animationStyle, animationInEnd, animationOutStart, animationStrength, and eventAt.",
			`template must be one of: ${MINIMAL_PRODUCT_UI_TEMPLATES.join(", ")}.`,
			`category must be one of: ${UI_ELEMENT_CATEGORIES.join(", ")}.`,
			"Use a compact high-contrast card or pill, generous rounding, one semantic accent color, concise editable copy, and no external image.",
			"Motion must serve meaning: reveal the container first, then its data/message, hold long enough to read, and leave cleanly.",
			"animationInEnd must be before animationOutStart. eventAt should sit between them.",
			"Use items as an array even when empty. Use only hex colors.",
		].join("\n"),
		prompt,
	});
	const parsed = uiElementPresetSchema.parse(value);
	const animationInEnd = Math.min(
		parsed.animationInEnd,
		parsed.animationOutStart - 12,
	);
	const animationOutStart = Math.max(
		parsed.animationOutStart,
		animationInEnd + 12,
	);
	const eventAt = Math.min(
		animationOutStart - 4,
		Math.max(animationInEnd + 4, parsed.eventAt),
	);

	const motion = UI_ELEMENT_MOTION[parsed.template];
	const strengthBias =
		parsed.animationStyle === "soft"
			? -15
			: parsed.animationStyle === "energetic"
				? 20
				: 0;

	return {
		name: parsed.name,
		description: parsed.description,
		category: parsed.category,
		keywords: [...new Set([...parsed.keywords, "product ui", parsed.template])],
		whenToUse: parsed.whenToUse,
		defaultDurationSeconds: parsed.defaultDurationSeconds,
		sourcePrompt: prompt,
		params: {
			template: parsed.template,
			label: parsed.label,
			secondary: parsed.secondary,
			items: parsed.items.join("\n"),
			itemCount: Math.max(1, parsed.items.length || 1),
			labelFontFamily: "Inter",
			secondaryFontFamily: "Inter",
			itemsFontFamily: "Inter",
			textDirection: "auto",
			textRevealMode: "determined-by-preset",
			textTransitionIn:
				parsed.animationStyle === "energetic" ? "zoom" : "blur-zoom",
			animationIn: motion.animationIn,
			animationInEnd,
			animationOut: motion.animationOut,
			animationOutStart,
			animationStrength: Math.max(
				40,
				Math.min(160, parsed.animationStrength + strengthBias),
			),
			eventAt,
			listRevealMode: "sequential",
			listBaseOpacity: 0,
			listGap: 16,
			listLeft: 12,
			listWidth: 76,
			listBarRadius: 18,
			listBarFitToText: true,
			listBackgroundBlur: 0,
			listTextAlign: "start",
			listTextSize: 24,
			accent: parsed.accent,
			background: parsed.background,
			foreground: parsed.foreground,
			progress: parsed.progress,
			checked: Math.min(parsed.items.length, 2),
			count: parsed.count,
			intensity: parsed.intensity,
			batteryMode: "drain",
			screenMode: "auto",
		},
	};
}
