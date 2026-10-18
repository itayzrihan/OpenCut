import { withAccount } from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import { brandKitTransaction } from "@/brand-kits/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withAccount(async () => {
	try {
		return Response.json(await brandKitTransaction(), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		return failure(error);
	}
});
export const POST = withAccount(async (request: Request) => {
	try {
		const body = JSON.parse(
			new TextDecoder().decode(
				await readBoundedBody({ request, maximumBytes: 160000 }),
			),
		);
		if (
			!Number.isSafeInteger(body.expectedRevision) ||
			body.expectedRevision < 0 ||
			typeof body.requestId !== "string"
		)
			throw new Error("Revision and request identity are required");
		return Response.json(
			await brandKitTransaction({
				edit: {
					expectedRevision: body.expectedRevision,
					requestId: body.requestId,
					change: body.change,
				},
			}),
		);
	} catch (error) {
		return failure(error);
	}
});
function failure(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return Response.json(
		{ error: message },
		{ status: /conflict|mismatch/i.test(message) ? 409 : 400 },
	);
}
