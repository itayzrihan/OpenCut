import type { NextRequest } from "next/server";
import { withAccount } from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import {
	generateSubscriptionImage,
	readSubscriptionImage,
	ImageHostError,
} from "@/editor-agent/server/subscription-image";
import { getOpenAIOAuthStatus } from "@/ai/server/openai-codex-oauth";
import { z } from "zod";
import { withProjectWriteRequest } from "@/editor-agent/server/project-write";
export const runtime = "nodejs";
export const POST = withAccount(async (request: NextRequest) => {
	try {
		const input = z
			.object({ projectId: z.string().min(1).max(256), request: z.unknown() })
			.strict()
			.parse(
				JSON.parse(
					new TextDecoder().decode(await readBoundedBody({ request: request, maximumBytes: 12_000_000 })),
				),
			);
		return Response.json(
			await withProjectWriteRequest({
				request,
				run: () =>
					generateSubscriptionImage({
						request,
						projectId: input.projectId,
						input: input.request,
					}),
			}),
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof ImageHostError
						? error.message
						: "Image operation failed; reconcile the same operationId before retrying",
				definitive: error instanceof ImageHostError && error.definitive,
			},
			{ status: 503 },
		);
	}
});
export const GET = withAccount(async (request: NextRequest) => {
	if (request.nextUrl.searchParams.has("jobKey")) {
		try {
			const bytes = await readSubscriptionImage({
				projectId: request.nextUrl.searchParams.get("projectId") ?? "",
				jobKey: request.nextUrl.searchParams.get("jobKey") ?? "",
			});
			return new Response(new Uint8Array(bytes), {
				headers: {
					"Content-Type": "image/png",
					"Content-Length": String(bytes.length),
					"Cache-Control": "no-store",
				},
			});
		} catch {
			return Response.json(
				{ error: "Owned image artifact unavailable" },
				{ status: 404 },
			);
		}
	}
	const { status } = await getOpenAIOAuthStatus({ request });
	return Response.json(
		{
			authenticated: status.authenticated,
			availability: "unverified",
			error: status.error,
			connectUrl: "/api/ai/oauth/start",
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
});
