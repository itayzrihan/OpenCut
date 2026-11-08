import { withAccount } from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import {
	readPeerStatus,
	configurePeerSharing,
	disconnectPeerPresence,
} from "@/peer-sync/host";
import { z } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withAccount(async () => {
	try {
		return Response.json(await readPeerStatus(), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Could not read device status",
			},
			{ status: 400 },
		);
	}
});
export const POST = withAccount(async (request: Request) => {
	try {
		if (request.headers.has("x-opencut-render-worker"))
			throw new Error("Render workers cannot configure device access");
		const input = z
			.discriminatedUnion("action", [
				z.object({ action: z.literal("heartbeat") }).strict(),
				z
					.object({ action: z.literal("configure"), enabled: z.boolean() })
					.strict(),
				z.object({ action: z.literal("disconnect") }).strict(),
			])
			.parse(
				JSON.parse(
					new TextDecoder().decode(
						await readBoundedBody({ request, maximumBytes: 1024 }),
					),
				),
			);
		if (input.action === "disconnect") {
			disconnectPeerPresence();
			return Response.json({ ok: true });
		}
		return Response.json(
			input.action === "configure"
				? await configurePeerSharing(input.enabled)
				: await readPeerStatus({ touch: true }),
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof Error ? error.message : "Device connection failed",
			},
			{ status: 400 },
		);
	}
});
