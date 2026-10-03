import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/auth/rate-limit";
import { submitFeedback, MAX_MESSAGE_LENGTH } from "@/feedback";
import { webEnv } from "@/env/web";

const submitSchema = z.object({
	message: z
		.string()
		.min(1, "Message is required")
		.max(MAX_MESSAGE_LENGTH, "Message too long"),
});

export async function POST(request: NextRequest) {
	if (!webEnv.DATABASE_URL) return NextResponse.json({ error: "Hosted feedback is not configured on this local installation." }, { status: 503 });
	const { limited } = await checkRateLimit({ request });
	if (limited) {
		return NextResponse.json({ error: "Too many requests" }, { status: 429 });
	}

	const body = await request.json();
	const result = submitSchema.safeParse(body);

	if (!result.success) {
		return NextResponse.json(
			{ error: "Invalid input", details: result.error.flatten().fieldErrors },
			{ status: 400 },
		);
	}

	const entry = await submitFeedback(result.data);
	return NextResponse.json({ entry }, { status: 201 });
}
