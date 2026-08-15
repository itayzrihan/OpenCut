import { z } from "zod";
import type { ReorganizeTakesPlan } from "@/timeline/reorganize-takes/apply-reorganize-takes";

export interface ReorganizeTakesPhraseInput {
	id: string;
	text: string;
	startTime: number;
	endTime: number;
}

const phraseIdSchema = z.string().trim().min(1).max(64);

const reorganizeTakesPlanSchema = z
	.object({
		order: z.array(phraseIdSchema).max(2000),
		cut: z.array(phraseIdSchema).max(2000),
		takeClusters: z
			.array(
				z
					.object({
						ids: z.array(phraseIdSchema).min(2).max(20),
						label: z.string().trim().min(1).max(80).optional(),
					})
					.strict(),
			)
			.max(100),
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

async function requestReorganizeTakesJson({
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

/**
 * Validates the raw parsed plan against the known phrase id set: `order` must be exactly the
 * phrase ids not present in `cut` (no missing, no duplicated, no unknown ids), and take-cluster
 * ids must reference kept phrases without overlapping across clusters. Throws on any violation —
 * this feature applies immediately with no review step, so a malformed plan must never reach the
 * timeline.
 */
export function validateReorganizeTakesPlan({
	value,
	phraseIds,
}: {
	value: unknown;
	phraseIds: string[];
}): ReorganizeTakesPlan {
	const parsed = reorganizeTakesPlanSchema.parse(value);
	const knownIds = new Set(phraseIds);
	const cutIds = new Set(parsed.cut);
	for (const id of parsed.cut) {
		if (!knownIds.has(id)) {
			throw new Error(`Reorganize-takes plan cut an unknown phrase id: ${id}`);
		}
	}

	const seenInOrder = new Set<string>();
	for (const id of parsed.order) {
		if (!knownIds.has(id)) {
			throw new Error(
				`Reorganize-takes plan ordered an unknown phrase id: ${id}`,
			);
		}
		if (cutIds.has(id)) {
			throw new Error(
				`Reorganize-takes plan both ordered and cut phrase id: ${id}`,
			);
		}
		if (seenInOrder.has(id)) {
			throw new Error(
				`Reorganize-takes plan ordered phrase id more than once: ${id}`,
			);
		}
		seenInOrder.add(id);
	}
	const expectedKeptCount = phraseIds.length - cutIds.size;
	if (seenInOrder.size !== expectedKeptCount) {
		throw new Error(
			"Reorganize-takes plan order did not cover every kept phrase exactly once",
		);
	}

	const seenInClusters = new Set<string>();
	for (const cluster of parsed.takeClusters) {
		for (const id of cluster.ids) {
			if (!seenInOrder.has(id)) {
				throw new Error(
					`Reorganize-takes plan clustered a phrase id that isn't kept: ${id}`,
				);
			}
			if (seenInClusters.has(id)) {
				throw new Error(
					`Reorganize-takes plan phrase id appears in more than one cluster: ${id}`,
				);
			}
			seenInClusters.add(id);
		}
	}

	return parsed;
}

/**
 * One-shot structured Codex call — intentionally bypasses the chat/tool-calling agent loop in
 * client-agent.ts, which is for multi-turn user-facing edits. This is a single scoped request
 * modeled on preset-generation.ts's requestPresetJson.
 */
export async function requestReorganizeTakesPlan({
	phrases,
}: {
	phrases: ReorganizeTakesPhraseInput[];
}): Promise<ReorganizeTakesPlan> {
	const compactPhrases = phrases.map((phrase) => ({
		id: phrase.id,
		text: phrase.text,
		startTime: Math.round(phrase.startTime * 100) / 100,
		endTime: Math.round(phrase.endTime * 100) / 100,
	}));

	const value = await requestReorganizeTakesJson({
		system: [
			"You reorganize a video's spoken takes from its transcript. You are given phrases",
			"(short spoken segments) already in near-correct chronological order — the editor",
			"already cut silences, so this is mostly a straight-through reading of a script.",
			"There is no ground-truth script text; use common sense about what a coherent,",
			"single-topic monologue reads like.",
			"",
			"Change order only for phrases that are clearly out of place (e.g. the speaker",
			"visibly jumped back to re-read something, or a sentence is interrupted by an",
			"unrelated one). Leave everything else exactly where it already is.",
			"",
			"Identify phrases that are repeated or near-duplicate readings of the same line",
			"(the speaker re-recording a take, full or partial) as takeClusters — do not pick a",
			'"best" one, just group them so the editor can compare and choose.',
			"",
			"Only cut a phrase entirely (via `cut`) when it is obviously unusable filler with no",
			"salvageable content (e.g. a false start with no words, or the speaker explicitly",
			'asking to redo the line). Do not cut phrases just because they\'re part of a',
			"take cluster — the editor picks the best take themselves.",
			"",
			"Return one JSON object: order (string[], every kept phrase id exactly once, in the",
			"corrected sequence), cut (string[], phrase ids to drop), and takeClusters",
			"(array of { ids: string[], label?: string }, each with 2+ phrase ids).",
		].join("\n"),
		prompt: JSON.stringify(compactPhrases),
	});

	return validateReorganizeTakesPlan({
		value,
		phraseIds: phrases.map((phrase) => phrase.id),
	});
}
