import type { EffectDefinition } from "@/effects/types";
import type { ParamValues } from "@/params";
import {
	buildGaussianBlurPasses,
	intensityToSigma,
} from "@/effects/definitions/blur";
import { TICKS_PER_SECOND } from "@/wasm";

export const CUSTOM_AI_EFFECT_TYPE = "custom-ai-effect";
export const CUSTOM_AI_EFFECT_SCHEMA_VERSION = "1";

const EFFECT_TYPE_ALIASES = new Map<string, string>([
	["blur-zoom", "blur"],
	["zoom-blur", "blur"],
	["blurzoom", "blur"],
]);

const SHADER_EFFECT_TEMPLATES = [
	"tint",
	"color-wash",
	"vignette",
	"pixelate",
	"rgb-split",
	"chromatic-shift",
	"scanlines",
	"noise",
] as const;

type ShaderEffectTemplate = (typeof SHADER_EFFECT_TEMPLATES)[number];

export function normalizeEffectType(effectType: string): string {
	const normalized = effectType.trim().toLowerCase().replace(/[\s_]+/g, "-");
	if (EFFECT_TYPE_ALIASES.has(normalized)) {
		return EFFECT_TYPE_ALIASES.get(normalized) ?? normalized;
	}
	if (/\bblur\b/.test(normalized)) {
		return "blur";
	}
	return normalized;
}

export function buildCustomAiEffectParams({
	requestedType,
	label,
	kind,
	intent,
	spec,
}: {
	requestedType: string;
	label?: string;
	kind?: string;
	intent?: string;
	spec?: unknown;
}): ParamValues {
	const trimmed = requestedType.trim();
	const resolvedLabel = label?.trim() || trimmed || "Custom AI edit";
	const resolvedKind = kind?.trim() || "effect";
	const resolvedIntent = intent?.trim() || trimmed || resolvedLabel;
	return {
		schemaVersion: CUSTOM_AI_EFFECT_SCHEMA_VERSION,
		label: resolvedLabel,
		kind: resolvedKind,
		requestedType: trimmed || "custom",
		intent: resolvedIntent,
		specJson: stringifyCustomAiEffectSpec({
			spec:
				spec ??
				({
					type: trimmed || "custom",
					kind: resolvedKind,
					intent: resolvedIntent,
				} satisfies Record<string, unknown>),
		}),
		status: "hosted",
		renderHint:
			"Stored as an AI-requested custom edit. Supported v1 effect templates render through OpenCut shader passes; unknown specs remain editable metadata.",
	};
}

export function stringifyCustomAiEffectSpec({ spec }: { spec: unknown }): string {
	if (typeof spec === "string") {
		const trimmed = spec.trim();
		if (!trimmed) {
			return "{}";
		}
		const parsed = parseJson({ value: trimmed });
		return parsed ? stableStringify(parsed) : trimmed;
	}
	return stableStringify(spec ?? {});
}

function parseJson({ value }: { value: string }): unknown | null {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sortForStableStringify(value), null, 2);
}

function sortForStableStringify(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortForStableStringify);
	}
	if (typeof value !== "object" || value === null) {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, nestedValue]) => [
				key,
				sortForStableStringify(nestedValue),
			]),
	);
}

function buildCustomAiEffectPasses({
	effectParams,
	width,
	height,
	localTime,
}: {
	effectParams: ParamValues;
	width: number;
	height: number;
	localTime?: number;
}) {
	const shaderPasses = buildShaderTemplatePasses({
		effectParams,
		localTime,
	});
	if (shaderPasses) {
		return shaderPasses;
	}

	const intensity = resolveBlurIntensity({ params: effectParams });
	if (intensity === null || intensity <= 0) {
		return [];
	}

	return buildGaussianBlurPasses({
		sigmaX: intensityToSigma({
			intensity,
			resolution: width,
			reference: 1920,
		}),
		sigmaY: intensityToSigma({
			intensity,
			resolution: height,
			reference: 1080,
		}),
	});
}

function buildShaderTemplatePasses({
	effectParams,
	localTime,
}: {
	effectParams: ParamValues;
	localTime?: number;
}) {
	const spec = parseJson({
		value: typeof effectParams.specJson === "string" ? effectParams.specJson : "",
	});
	const template = resolveShaderTemplate({ params: effectParams, spec });
	if (!template) {
		return null;
	}

	const intensity = resolveTemplateIntensity({ params: effectParams, spec });
	const color = resolveTemplateColor({ params: effectParams, spec, template });
	const timeSeconds =
		typeof localTime === "number" && Number.isFinite(localTime)
			? localTime / TICKS_PER_SECOND
			: 0;

	switch (template) {
		case "tint":
		case "color-wash":
			return [
				{
					shader: template,
					uniforms: {
						u_intensity: intensity,
						u_color: color,
					},
				},
			];
		case "vignette":
			return [
				{
					shader: "vignette",
					uniforms: {
						u_intensity: intensity,
						u_color: color,
					},
				},
			];
		case "pixelate":
			return [
				{
					shader: "pixelate",
					uniforms: {
						u_intensity: intensity,
						u_amount: 2 + intensity * 54,
					},
				},
			];
		case "rgb-split":
		case "chromatic-shift":
			return [
				{
					shader: template,
					uniforms: {
						u_intensity: intensity,
						u_amount: 1 + intensity * 28,
					},
				},
			];
		case "scanlines":
			return [
				{
					shader: "scanlines",
					uniforms: {
						u_intensity: intensity,
						u_amount: 3 + intensity * 8,
						u_time: timeSeconds,
					},
				},
			];
		case "noise":
			return [
				{
					shader: "noise",
					uniforms: {
						u_intensity: intensity,
						u_amount: 1 + (1 - intensity) * 2,
						u_time: timeSeconds,
						u_seed: resolveTemplateSeed({ params: effectParams, spec }),
					},
				},
			];
	}
}

function resolveShaderTemplate({
	params,
	spec,
}: {
	params: ParamValues;
	spec: unknown;
}): ShaderEffectTemplate | null {
	const directTemplate = findStringForKeys({
		value: spec,
		keys: ["template", "effect", "type", "shader"],
	});
	const normalizedDirect = normalizeShaderTemplate({ value: directTemplate });
	if (normalizedDirect) {
		return normalizedDirect;
	}

	const text = [
		params.label,
		params.kind,
		params.requestedType,
		params.intent,
		params.specJson,
	]
		.filter((value) => typeof value === "string")
		.join(" ")
		.toLowerCase();
	return normalizeShaderTemplate({ value: text });
}

function normalizeShaderTemplate({
	value,
}: {
	value: string | null;
}): ShaderEffectTemplate | null {
	if (!value) {
		return null;
	}
	const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
	if (normalized.includes("color-wash")) return "color-wash";
	if (normalized.includes("chromatic-shift")) return "chromatic-shift";
	if (normalized.includes("rgb-split")) return "rgb-split";
	if (normalized.includes("scanline") || normalized.includes("scan-line")) {
		return "scanlines";
	}
	for (const template of SHADER_EFFECT_TEMPLATES) {
		if (normalized.includes(template)) {
			return template;
		}
	}
	return null;
}

function resolveTemplateIntensity({
	params,
	spec,
}: {
	params: ParamValues;
	spec: unknown;
}): number {
	const direct =
		readNumberParam({ params, key: "intensity" }) ??
		findLargestNumberForKeys({
			value: spec,
			keys: ["intensity", "strength", "amount", "opacity"],
		});
	return clamp01((direct ?? 60) / 100);
}

function resolveTemplateColor({
	params,
	spec,
	template,
}: {
	params: ParamValues;
	spec: unknown;
	template: ShaderEffectTemplate;
}): [number, number, number, number] {
	const value =
		readStringParam({ params, key: "color" }) ??
		findStringForKeys({ value: spec, keys: ["color", "tint", "accent"] });
	const parsed = parseHexColor({ value });
	if (parsed) {
		return parsed;
	}
	switch (template) {
		case "vignette":
			return [0.02, 0.015, 0.035, 1];
		case "tint":
		case "color-wash":
			return [0.18, 0.75, 1, 1];
		default:
			return [1, 1, 1, 1];
	}
}

function resolveTemplateSeed({
	params,
	spec,
}: {
	params: ParamValues;
	spec: unknown;
}): number {
	const direct =
		readNumberParam({ params, key: "seed" }) ??
		findLargestNumberForKeys({ value: spec, keys: ["seed"] });
	if (direct !== null) {
		return direct;
	}
	return hashString(
		[
			params.label,
			params.requestedType,
			params.intent,
			params.specJson,
		]
			.filter((value) => typeof value === "string")
			.join(":"),
	);
}

function resolveBlurIntensity({
	params,
}: {
	params: ParamValues;
}): number | null {
	const text = [
		params.label,
		params.kind,
		params.requestedType,
		params.intent,
		params.specJson,
	]
		.filter((value) => typeof value === "string")
		.join(" ")
		.toLowerCase();
	const spec = parseJson({
		value: typeof params.specJson === "string" ? params.specJson : "",
	});
	const intensityFromSpec = findLargestBlurNumber({ value: spec });
	if (intensityFromSpec !== null) {
		return clampBlurIntensity({ value: intensityFromSpec });
	}
	if (text.includes("blur")) {
		return 15;
	}
	return null;
}

function findLargestBlurNumber({ value }: { value: unknown }): number | null {
	let largest: number | null = null;
	const visit = ({ current, parentKey }: { current: unknown; parentKey: string }) => {
		if (typeof current === "number" && Number.isFinite(current)) {
			if (parentKey.toLowerCase().includes("blur")) {
				largest = Math.max(largest ?? 0, current);
			}
			return;
		}
		if (typeof current === "string") {
			const parsed = Number.parseFloat(current);
			if (Number.isFinite(parsed) && parentKey.toLowerCase().includes("blur")) {
				largest = Math.max(largest ?? 0, parsed);
			}
			const blurMatch = current.match(/blur\D*(\d+(?:\.\d+)?)/i);
			if (blurMatch?.[1]) {
				const blurValue = Number.parseFloat(blurMatch[1]);
				if (Number.isFinite(blurValue)) {
					largest = Math.max(largest ?? 0, blurValue);
				}
			}
			return;
		}
		if (Array.isArray(current)) {
			for (const item of current) {
				visit({ current: item, parentKey });
			}
			return;
		}
		if (typeof current === "object" && current !== null) {
			for (const [key, nestedValue] of Object.entries(current)) {
				visit({ current: nestedValue, parentKey: key });
			}
		}
	};
	visit({ current: value, parentKey: "" });
	return largest;
}

function clampBlurIntensity({ value }: { value: number }): number {
	return Math.max(0, Math.min(100, value));
}

function findLargestNumberForKeys({
	value,
	keys,
}: {
	value: unknown;
	keys: string[];
}): number | null {
	let largest: number | null = null;
	const visit = ({ current, key }: { current: unknown; key: string }) => {
		const keyMatches = keys.some((candidate) =>
			key.toLowerCase().includes(candidate.toLowerCase()),
		);
		if (keyMatches) {
			const numberValue =
				typeof current === "number"
					? current
					: typeof current === "string"
						? Number.parseFloat(current)
						: Number.NaN;
			if (Number.isFinite(numberValue)) {
				largest = Math.max(largest ?? 0, numberValue);
			}
		}
		if (Array.isArray(current)) {
			for (const item of current) {
				visit({ current: item, key });
			}
			return;
		}
		if (typeof current === "object" && current !== null) {
			for (const [nestedKey, nestedValue] of Object.entries(current)) {
				visit({ current: nestedValue, key: nestedKey });
			}
		}
	};
	visit({ current: value, key: "" });
	return largest;
}

function findStringForKeys({
	value,
	keys,
}: {
	value: unknown;
	keys: string[];
}): string | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	for (const [key, nestedValue] of Object.entries(value)) {
		if (
			typeof nestedValue === "string" &&
			keys.some((candidate) => key.toLowerCase() === candidate.toLowerCase())
		) {
			return nestedValue;
		}
		const nested = findStringForKeys({ value: nestedValue, keys });
		if (nested) {
			return nested;
		}
	}
	return null;
}

function readStringParam({
	params,
	key,
}: {
	params: ParamValues;
	key: string;
}): string | null {
	const value = params[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumberParam({
	params,
	key,
}: {
	params: ParamValues;
	key: string;
}): number | null {
	const value = params[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseHexColor({
	value,
}: {
	value: string | null;
}): [number, number, number, number] | null {
	if (!value) {
		return null;
	}
	const match = value.trim().match(/^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
	if (!match?.[1]) {
		return null;
	}
	const hex = match[1];
	const alphaHex = match[2] ?? "ff";
	return [
		Number.parseInt(hex.slice(0, 2), 16) / 255,
		Number.parseInt(hex.slice(2, 4), 16) / 255,
		Number.parseInt(hex.slice(4, 6), 16) / 255,
		Number.parseInt(alphaHex, 16) / 255,
	];
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function hashString(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) % 10_000;
}

export const customAiEffectDefinition: EffectDefinition = {
	type: CUSTOM_AI_EFFECT_TYPE,
	name: "Custom AI Edit",
	keywords: ["ai", "custom", "hyperframes", "extension"],
	params: [
		{
			key: "schemaVersion",
			label: "Schema Version",
			type: "text",
			default: CUSTOM_AI_EFFECT_SCHEMA_VERSION,
			keyframable: false,
		},
		{
			key: "label",
			label: "Label",
			type: "text",
			default: "Custom AI edit",
			keyframable: false,
		},
		{
			key: "kind",
			label: "Kind",
			type: "text",
			default: "effect",
			keyframable: false,
		},
		{
			key: "requestedType",
			label: "Requested Effect",
			type: "text",
			default: "custom",
			keyframable: false,
		},
		{
			key: "intent",
			label: "Intent",
			type: "text",
			default: "Custom AI edit",
			keyframable: false,
		},
		{
			key: "specJson",
			label: "Spec JSON",
			type: "text",
			default: "{}",
			keyframable: false,
		},
		{
			key: "status",
			label: "Status",
			type: "text",
			default: "hosted",
			keyframable: false,
		},
		{
			key: "renderHint",
			label: "Render Hint",
			type: "text",
			default:
				"Stored as an AI-requested custom edit. Supported v1 effect templates render through OpenCut shader passes; unknown specs remain editable metadata.",
			keyframable: false,
		},
	],
	renderer: {
		passes: [],
		buildPasses: buildCustomAiEffectPasses,
	},
};
