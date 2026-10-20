import { z } from "zod";
const part = z
	.object({
		firstWord: z.number().int().nonnegative(),
		lastWord: z.number().int().nonnegative(),
	})
	.strict();
const label = z.string().trim().min(1).max(2000);
const alternative = z
	.object({ label, reason: label, parts: z.array(part).min(1).max(100) })
	.strict();
export const podcastVideoSchema = z
	.object({
		title: label,
		openingHook: label,
		endingHook: label,
		confidence: z.number().min(0).max(1),
		groups: z
			.array(
				z
					.object({
						label,
						confidence: z.number().min(0).max(1),
						selected: z.number().int().nonnegative().max(19),
						alternatives: z.array(alternative).min(1).max(20),
					})
					.strict(),
			)
			.min(1)
			.max(1000)
			.optional(),
		discarded: z
			.array(part.extend({ reason: label }))
			.max(15000)
			.optional(),
		alternatives: z
			.array(
				z
					.object({ label, reason: label, parts: z.array(part).min(1).max(12) })
					.strict(),
			)
			.max(5),
	})
	.strict();
const proposalSchema = z
	.object({ videos: z.array(podcastVideoSchema).max(32) })
	.strict();
export function parsePodcastProposal(text: string) {
	const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
	return proposalSchema.parse(
		JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)),
	).videos;
}
