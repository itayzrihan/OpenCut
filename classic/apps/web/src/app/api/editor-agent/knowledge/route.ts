import { withAccount } from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import {
	operateKnowledge,
	KnowledgeRejected,
} from "@/editor-agent/server/knowledge";
import { z } from "zod";

export const runtime = "nodejs";
export const POST = withAccount(async (request) => {
	try {
		const bytes = await readBoundedBody({ request: request, maximumBytes: 400_000 });
		const input = z
			.object({ projectId: z.string().min(1).max(256), request: z.unknown() })
			.strict()
			.parse(JSON.parse(new TextDecoder().decode(bytes)));
		return Response.json(await operateKnowledge(input));
	} catch (error) {
		const definitive =
			error instanceof KnowledgeRejected ||
			error instanceof z.ZodError ||
			error instanceof SyntaxError;
		return Response.json(
			{
				error: error instanceof Error ? error.message : String(error),
				definitive,
			},
			{ status: definitive ? 400 : 503 },
		);
	}
});
