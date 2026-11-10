import { withAccount } from "@/accounts/server";
import {
	listReviews,
	createReview,
	reviewResponse,
} from "@/client-review/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withAccount(async (request: Request) =>
	reviewResponse(() => listReviews(request)),
);
export const POST = withAccount(async (request: Request) =>
	reviewResponse(() => createReview(request)),
);
