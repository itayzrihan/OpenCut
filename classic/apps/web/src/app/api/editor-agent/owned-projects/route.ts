import { z } from "zod";
import { withAccount } from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import {
	copyOwnedMedia,
	readOwnedProject,
	OwnedProjectRejected,
} from "@/editor-agent/server/owned-projects";
import { withProjectWriteRequest } from "@/editor-agent/server/project-write";
export const runtime = "nodejs";
export const POST = withAccount(async (request) =>
	withProjectWriteRequest({
		request,
		run: async () => {
			try {
				const input = z
					.object({
						projectId: z.string().min(1).max(160),
						request: z.unknown(),
						copy: z.boolean().optional(),
					})
					.strict()
					.parse(
						JSON.parse(
							new TextDecoder().decode(
								await readBoundedBody({ request, maximumBytes: 16000 }),
							),
						),
					);
				return Response.json(
					input.copy
						? await copyOwnedMedia({
								projectId: input.projectId,
								request: input.request,
								signal: request.signal,
							})
						: await readOwnedProject(input),
				);
			} catch (error) {
				const definitive =
					error instanceof OwnedProjectRejected ||
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
		},
	}),
);
