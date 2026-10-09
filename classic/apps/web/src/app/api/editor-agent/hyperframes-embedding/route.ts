import { withAccount } from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import { embedReference } from "@/editor-agent/server/hyperframes-embedding";
import { z } from "zod";

export const runtime = "nodejs";
export const POST = withAccount(async (request) => {
	try {
		const bytes = await readBoundedBody({ request: request, maximumBytes: 8_000 });
		const input = z
			.object({ projectId: z.string().min(1).max(256), request: z.unknown() })
			.strict()
			.parse(JSON.parse(new TextDecoder().decode(bytes)));
		return Response.json(
			await embedReference({ ...input, signal: request.signal }),
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		// Reads have no editor commit to reconcile; unavailable inference explicitly
		// permits the caller to choose the existing lexical search capability.
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Local embedding unavailable",
				definitive: true,
			},
			{ status: 503 },
		);
	}
});
