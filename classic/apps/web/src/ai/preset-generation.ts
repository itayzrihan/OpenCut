import { z } from "zod";
import { BACKGROUND_PRESETS } from "@/backgrounds/presets";
import {
	buildCustomAiEffectParams,
	CUSTOM_AI_EFFECT_TYPE,
} from "@/effects/custom-ai-effect";
import type { GeneratedBackgroundPreset, GeneratedEffectPreset } from "@/shared-library";

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
