import { z } from "zod";
const part = z
	.object({
		firstWord: z.number().int().nonnegative(),
		lastWord: z.number().int().nonnegative(),
	})
	.strict();
const label = z.string().trim().min(1).max(2000);
export const podcastVideoSchema = z
	.object({
		title: label,
		openingHook: label,
		endingHook: label,
		confidence: z.number().min(0).max(1),
		alternatives: z
			.array(
				z
					.object({ label, reason: label, parts: z.array(part).min(1).max(12) })
					.strict(),
			)
			.min(1)
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
