import { describe, expect, test } from "bun:test";
import {
	DEFAULT_CHATGPT_CODEX_MODEL,
	buildChatGptCodexModelsFromDiscovery,
	getCodexModelCandidates,
	isUnsupportedCodexModelError,
	normalizeCodexModelId,
} from "@/ai/codex-models";

describe("Codex model helpers", () => {
	test("normalizes legacy ChatGPT Codex model ids to the current default", () => {
		expect(normalizeCodexModelId("gpt-5.1-codex")).toBe(
			DEFAULT_CHATGPT_CODEX_MODEL,
		);
		expect(normalizeCodexModelId("codex:gpt-5.3-codex")).toBe(
			DEFAULT_CHATGPT_CODEX_MODEL,
		);
		expect(normalizeCodexModelId("gpt-5.4-codex")).toBe("gpt-5.4");
		expect(normalizeCodexModelId("gpt-5.6")).toBe(DEFAULT_CHATGPT_CODEX_MODEL);
	});

	test("keeps explicit unknown model ids first so experiments remain possible", () => {
		expect(getCodexModelCandidates("future-model").at(0)).toBe("future-model");
	});

	test("includes supported fallbacks after the requested model", () => {
		expect(getCodexModelCandidates("gpt-5.1-codex")).toEqual([
			DEFAULT_CHATGPT_CODEX_MODEL,
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.4-mini",
		]);
	});

	test("recognizes unsupported model errors from the Codex backend", () => {
		expect(
			isUnsupportedCodexModelError({
				status: 400,
				message:
					"The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account.",
			}),
		).toBe(true);
		expect(
			isUnsupportedCodexModelError({
				status: 401,
				message: "Unauthorized",
			}),
		).toBe(false);
	});

	test("maps live ChatGPT Codex discovery rows", () => {
		const models = buildChatGptCodexModelsFromDiscovery({
			models: [
				{
					slug: "gpt-5.6-sol",
					display_name: "GPT-5.6 Sol",
					visibility: "list",
					show_in_picker: true,
					supported_reasoning_levels: [
						{ effort: "low", description: "low" },
						{ effort: "xhigh", description: "xhigh" },
					],
					input_modalities: ["text", "image"],
					context_window: 372_000,
					max_context_window: 1_000_000,
					max_output_tokens: 128_000,
				},
				{
					slug: "hidden-review-model",
					display_name: "Hidden Review Model",
					visibility: "hide",
				},
				{
					id: "picker-disabled",
					display_name: "Picker Disabled",
					showInPicker: false,
				},
				{
					id: "gpt-5.5",
					display_name: "GPT-5.5",
					supportedReasoningLevels: ["low", "medium"],
				},
			],
		});

		expect(models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
		expect(models[0]).toMatchObject({
			label: "GPT-5.6 Sol",
			recommended: true,
			source: "live",
			inputModalities: ["text", "image"],
			reasoningEfforts: ["low", "xhigh"],
			contextTokens: 372_000,
			contextWindow: 1_000_000,
			maxOutputTokens: 128_000,
		});
		expect(models[1]).toMatchObject({
			id: "gpt-5.5",
			reasoningEfforts: ["low", "medium"],
		});
	});
});
