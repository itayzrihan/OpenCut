import { z } from "zod";
const outputSchema = z
	.object({
		output_text: z.string().optional(),
		output: z
			.array(
				z
					.object({
						type: z.string().optional(),
						content: z
							.array(
								z
									.object({
										type: z.string().optional(),
										text: z.string().optional(),
									})
									.passthrough(),
							)
							.optional(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();
/** /api/ai/chat wraps Responses API output in {response}; never display reasoning. */
export function directorReply(body: unknown) {
	const envelope = z
		.object({ response: z.unknown() })
		.passthrough()
		.parse(body);
	const response = outputSchema.parse(envelope.response);
	const text =
		response.output_text ??
		(response.output ?? [])
			.filter((o) => o.type === "message")
			.flatMap((o) => o.content ?? [])
			.filter((c) => c.type === "output_text" || c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
	if (!text.trim()) throw new Error("No directing response received");
	return text;
}
