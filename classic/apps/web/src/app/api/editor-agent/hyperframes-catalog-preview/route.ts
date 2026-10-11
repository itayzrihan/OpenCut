import { withAccount, requireAccount } from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import { catalogPreviews } from "@/hyperframes/catalog-preview-server";
import { z } from "zod";
export const runtime = "nodejs";
const input = z
	.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
		upstreamCommit: z.string().regex(/^[a-f0-9]{40}$/),
	})
	.strict();
export const POST = withAccount(async (request) => {
	try {
		const body = input.parse(
			JSON.parse(
				new TextDecoder().decode(
					await readBoundedBody({ request, maximumBytes: 2048 }),
				),
			),
		);
		return Response.json(
			await catalogPreviews().open({
				accountId: requireAccount().id,
				input: body,
				signal: request.signal,
			}),
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Preview unavailable" },
			{ status: 400, headers: { "Cache-Control": "no-store" } },
		);
	}
});
export const DELETE = withAccount(async (request) => {
	const id = new URL(request.url).searchParams.get("id") ?? "";
	if (!/^[a-f0-9]{48}$/.test(id)) return new Response(null, { status: 400 });
	catalogPreviews().release({ accountId: requireAccount().id, id });
	return new Response(null, { status: 204 });
});
