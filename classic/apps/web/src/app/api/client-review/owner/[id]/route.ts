import { withAccount } from "@/accounts/server";
import {
	getOwnerReview,
	uploadReview,
	updateReview,
	revokeReview,
	reviewResponse,
} from "@/client-review/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
type Context = {
	params: Promise<{
		id: string;
	}>;
};
export const GET = withAccount(async (request: Request, context: Context) =>
	reviewResponse(async () =>
		getOwnerReview({
			request: request,
			id: (await context.params).id,
		}),
	),
);
export const PUT = withAccount(async (request: Request, context: Context) =>
	reviewResponse(async () =>
		uploadReview({
			request: request,
			id: (await context.params).id,
		}),
	),
);
export const PATCH = withAccount(async (request: Request, context: Context) =>
	reviewResponse(async () =>
		updateReview({
			request: request,
			id: (await context.params).id,
		}),
	),
);
export const DELETE = withAccount(async (request: Request, context: Context) =>
	reviewResponse(async () =>
		revokeReview({
			request: request,
			id: (await context.params).id,
		}),
	),
);
