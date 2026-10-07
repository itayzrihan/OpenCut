import { withAccount } from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import { BatchWriteRejected, withBatchProjectWrite } from "@/batch/server";
import {
	operateEditorSession,
	SessionRejected,
} from "@/editor-agent/server/session-store";
import { z } from "zod";

export const runtime = "nodejs";
export const POST = withAccount(async (request) => {
	try {
		const input = z
			.object({
				projectId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
				request: z
					.object({
						type: z.enum(["read", "acquire", "renew", "release", "commit"]),
					})
					.passthrough(),
			})
			.strict()
			.parse(
				JSON.parse(
					new TextDecoder().decode(
						await readBoundedBody({ request: request, maximumBytes: 128 * 1024 * 1024 }),
					),
				),
			);
		const write = (context?: { assertLock: () => void }) =>
			operateEditorSession({ ...input, assertHostLock: context?.assertLock });
		const result =
			input.request.type === "read"
				? await write()
				: await withBatchProjectWrite({
						projectId: input.projectId,
						token: request.headers.get("X-OpenCut-Batch-Token"),
						write,
					});
		return Response.json(result, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		const definitive =
			error instanceof SessionRejected ||
			error instanceof BatchWriteRejected ||
			error instanceof z.ZodError ||
			error instanceof SyntaxError;
		return Response.json(
			{
				error: error instanceof Error ? error.message : String(error),
				definitive,
			},
			{ status: definitive ? 409 : 503 },
		);
	}
});
