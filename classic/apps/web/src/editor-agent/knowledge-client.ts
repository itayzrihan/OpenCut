import { z } from "zod";

export const knowledgeLocationSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("builtin") }),
	z.object({ type: z.literal("global") }),
	z.object({ type: z.literal("project"), projectId: z.string() }),
]);
export const knowledgeKeySchema = z.object({
	kind: z.enum(["skill", "memory"]),
	id: z.string(),
});
export const knowledgeContentSchema = z.object({
	title: z.string(),
	body: z.string(),
	tags: z.array(z.string()),
	enabled: z.boolean(),
});
export const knowledgeDocumentSchema = z.object({
	key: knowledgeKeySchema,
	location: knowledgeLocationSchema,
	versions: z
		.array(
			z.object({
				version: z.number(),
				storeRevision: z.number(),
				savedAtMs: z.number(),
				content: knowledgeContentSchema,
				deleted: z.boolean(),
			}),
		)
		.min(1),
});
export const knowledgeSummarySchema = z.object({
	key: knowledgeKeySchema,
	location: knowledgeLocationSchema,
	title: z.string(),
	description: z.string(),
	tags: z.array(z.string()),
	version: z.number(),
	enabled: z.boolean(),
	deleted: z.boolean(),
	readOnly: z.boolean(),
	excludedInProject: z.boolean(),
});
export type KnowledgeSummary = z.infer<typeof knowledgeSummarySchema>;
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

export async function knowledgeRequest({
	projectId,
	request,
	signal,
}: {
	projectId: string;
	request: unknown;
	signal?: AbortSignal;
}) {
	const account = window.__opencutAccountId;
	const response = await fetch("/api/editor-agent/knowledge", {
		method: "POST",
		credentials: "same-origin",
		headers: {
			"Content-Type": "application/json",
			...(account ? { "X-OpenCut-Account": account } : {}),
		},
		body: JSON.stringify({ projectId, request }),
		signal,
	});
	if (account !== window.__opencutAccountId)
		throw new Error("The active knowledge account changed");
	const json: unknown = await response.json();
	if (!response.ok)
		throw new Error(
			z.object({ error: z.string() }).safeParse(json).data?.error ??
				"Knowledge request failed",
		);
	return z
		.object({ revision: z.number(), changed: z.boolean(), data: z.unknown() })
		.parse(json);
}
