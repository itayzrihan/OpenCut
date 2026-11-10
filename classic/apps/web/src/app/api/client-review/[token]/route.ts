/* eslint-disable opencut/prefer-object-params -- Next.js route handlers require the (request, context) signature. */
import {
	publicReview,
	mutatePublicReview,
	reviewResponse,
} from "@/client-review/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {
	params: Promise<{
		token: string;
	}>;
};
export const GET = async (request: Request, context: Context) =>
	reviewResponse(async () =>
		publicReview({
			request: request,
			token: (await context.params).token,
		}),
	);
export const POST = async (request: Request, context: Context) =>
	reviewResponse(async () =>
		mutatePublicReview({
			request: request,
			token: (await context.params).token,
		}),
	);
