export interface ChatGptCodexModel {
	id: string;
	label: string;
	description: string;
	recommended?: boolean;
	requiresPlan?: "pro";
	source?: "static" | "live";
	inputModalities?: string[];
	reasoningEfforts?: string[];
	contextWindow?: number;
	contextTokens?: number;
	maxOutputTokens?: number;
}

export const DEFAULT_CHATGPT_CODEX_MODEL = "gpt-5.6-sol";

export const CHATGPT_CODEX_MODEL_FALLBACKS = [
	DEFAULT_CHATGPT_CODEX_MODEL,
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
] as const;

export const CHATGPT_CODEX_MODELS: ChatGptCodexModel[] = [
	{
		id: DEFAULT_CHATGPT_CODEX_MODEL,
		label: "GPT-5.6 Sol",
		description: "Recommended Codex model for ChatGPT sign-in.",
		recommended: true,
	},
	{
		id: "gpt-5.5",
		label: "GPT-5.5",
		description: "Previous frontier model for complex reasoning and coding.",
	},
	{
		id: "gpt-5.4",
		label: "GPT-5.4",
		description: "Previous frontier Codex-capable model.",
	},
	{
		id: "gpt-5.4-mini",
		label: "GPT-5.4 Mini",
		description: "Faster model for smaller edits and lighter tool loops.",
	},
	{
		id: "gpt-5.3-codex-spark",
		label: "GPT-5.3 Codex Spark",
		description: "Research preview Codex model.",
		requiresPlan: "pro",
	},
];

const LEGACY_MODEL_ALIASES: Record<string, string> = {
	"gpt-5.1": DEFAULT_CHATGPT_CODEX_MODEL,
	"gpt-5.1-codex": DEFAULT_CHATGPT_CODEX_MODEL,
	"gpt-5.1-codex-max": DEFAULT_CHATGPT_CODEX_MODEL,
	"gpt-5.1-codex-mini": DEFAULT_CHATGPT_CODEX_MODEL,
	"gpt-5.2": DEFAULT_CHATGPT_CODEX_MODEL,
	"gpt-5.2-codex": DEFAULT_CHATGPT_CODEX_MODEL,
	"gpt-5.3-codex": DEFAULT_CHATGPT_CODEX_MODEL,
	"gpt-5.3-codex-mini": DEFAULT_CHATGPT_CODEX_MODEL,
	"gpt-5.3-instant": DEFAULT_CHATGPT_CODEX_MODEL,
	"gpt-5.3-instant-codex": DEFAULT_CHATGPT_CODEX_MODEL,
	"gpt-5.4-codex": "gpt-5.4",
	"gpt-5.4-codex-max": "gpt-5.4",
	"gpt-5.4-codex-mini": "gpt-5.4-mini",
	"gpt-5.6": DEFAULT_CHATGPT_CODEX_MODEL,
};

export function normalizeCodexModelId(value?: string | null): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		return DEFAULT_CHATGPT_CODEX_MODEL;
	}

	const withoutProvider = trimmed.startsWith("codex:")
		? trimmed.slice("codex:".length).trim()
		: trimmed;
	const lower = withoutProvider.toLowerCase();
	return LEGACY_MODEL_ALIASES[lower] ?? withoutProvider;
}

export function getCodexModelCandidates(value?: string | null): string[] {
	return uniqueStrings([
		normalizeCodexModelId(value),
		...CHATGPT_CODEX_MODEL_FALLBACKS,
	]);
}

export function isUnsupportedCodexModelError({
	status,
	message,
}: {
	status: number;
	message: string;
}): boolean {
	const normalizedMessage = message.toLowerCase();
	return (
		status === 400 &&
		normalizedMessage.includes("model") &&
		(normalizedMessage.includes("not supported") ||
			normalizedMessage.includes("unsupported"))
	);
}

export function buildChatGptCodexModelsFromDiscovery(
	value: unknown,
): ChatGptCodexModel[] {
	const rows = readCodexDiscoveryRows(value);
	return rows
		.map(buildChatGptCodexModelFromDiscoveryRow)
		.filter((model): model is ChatGptCodexModel => model !== null);
}

function uniqueStrings(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		unique.push(value);
	}
	return unique;
}

function buildChatGptCodexModelFromDiscoveryRow(
	row: unknown,
): ChatGptCodexModel | null {
	if (!shouldIncludeCodexDiscoveryRow(row)) {
		return null;
	}

	const id = readString({ row, key: "slug" }) ?? readString({ row, key: "id" });
	if (!id) {
		return null;
	}

	const fallback = CHATGPT_CODEX_MODELS.find(
		(model) => model.id.toLowerCase() === id.toLowerCase(),
	);
	const reasoningEfforts = readReasoningEfforts(row);
	const inputModalities = readStringArray({
		row,
		keys: ["input_modalities", "inputModalities"],
	});
	const contextTokens = readPositiveInteger({
		row,
		keys: ["context_window", "contextWindow"],
	});
	const contextWindow = readPositiveInteger({
		row,
		keys: ["max_context_window", "maxContextWindow"],
	});
	const maxOutputTokens = readPositiveInteger({
		row,
		keys: [
			"max_output_tokens",
			"maxOutputTokens",
			"max_completion_tokens",
			"maxCompletionTokens",
		],
	});
	const resolvedContextWindow = contextWindow ?? fallback?.contextWindow;
	const resolvedMaxOutputTokens = maxOutputTokens ?? fallback?.maxOutputTokens;

	return {
		id,
		label: readString({ row, key: "display_name" }) ?? fallback?.label ?? id,
		description:
			fallback?.description ?? "Available in your ChatGPT Codex account.",
		...((fallback?.recommended ?? id === DEFAULT_CHATGPT_CODEX_MODEL)
			? { recommended: true }
			: {}),
		...(fallback?.requiresPlan ? { requiresPlan: fallback.requiresPlan } : {}),
		source: "live",
		...(inputModalities.length > 0 ? { inputModalities } : {}),
		...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
		...(contextTokens ? { contextTokens } : {}),
		...(resolvedContextWindow ? { contextWindow: resolvedContextWindow } : {}),
		...(resolvedMaxOutputTokens
			? { maxOutputTokens: resolvedMaxOutputTokens }
			: {}),
	};
}

function readCodexDiscoveryRows(value: unknown): unknown[] {
	if (!isRecord(value)) {
		return [];
	}
	return Array.isArray(value.models) ? value.models : [];
}

function shouldIncludeCodexDiscoveryRow(row: unknown): boolean {
	const visibility = (
		readString({ row, key: "visibility" }) ?? ""
	).toLowerCase();
	if (visibility && visibility !== "list") {
		return false;
	}
	const showInPicker =
		readBoolean({ row, key: "show_in_picker" }) ??
		readBoolean({ row, key: "showInPicker" });
	return showInPicker !== false;
}

function readReasoningEfforts(row: unknown): string[] {
	if (!isRecord(row)) {
		return [];
	}
	const value = row.supported_reasoning_levels ?? row.supportedReasoningLevels;
	if (!Array.isArray(value)) {
		return [];
	}

	return uniqueStrings(
		value.flatMap((entry) => {
			if (typeof entry === "string" && entry.trim()) {
				return [entry.trim()];
			}
			if (isRecord(entry)) {
				const effort = entry.effort;
				return typeof effort === "string" && effort.trim()
					? [effort.trim()]
					: [];
			}
			return [];
		}),
	);
}

function readPositiveInteger({
	row,
	keys,
}: {
	row: unknown;
	keys: readonly string[];
}): number | undefined {
	if (!isRecord(row)) {
		return undefined;
	}
	for (const key of keys) {
		const value = row[key];
		if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
			return value;
		}
	}
	return undefined;
}

function readStringArray({
	row,
	keys,
}: {
	row: unknown;
	keys: readonly string[];
}): string[] {
	if (!isRecord(row)) {
		return [];
	}
	for (const key of keys) {
		const value = row[key];
		if (Array.isArray(value)) {
			return value.filter(
				(entry): entry is string => typeof entry === "string" && !!entry.trim(),
			);
		}
	}
	return [];
}

function readString({
	row,
	key,
}: {
	row: unknown;
	key: string;
}): string | undefined {
	if (!isRecord(row)) {
		return undefined;
	}
	const value = row[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean({
	row,
	key,
}: {
	row: unknown;
	key: string;
}): boolean | undefined {
	if (!isRecord(row)) {
		return undefined;
	}
	const value = row[key];
	return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
