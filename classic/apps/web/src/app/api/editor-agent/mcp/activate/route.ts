import { accountDataLocked } from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import {
	activateMcpInstallation,
	mcpLocalOrigin,
	parseMcpCredential,
} from "@/mcp/server/delegation";
import { z } from "zod";

export const runtime = "nodejs";
const headers = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
};

export async function POST(request: Request) {
	try {
		mcpLocalOrigin(request);
		if (request.headers.has("origin")) throw new Error();
	} catch {
		return Response.json(
			{ error: "Use the local POCUT host or a private SSH forward." },
			{ status: 403, headers },
		);
	}
	const credential = parseMcpCredential(
		request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "",
		"setup",
	);
	if (!credential)
		return Response.json(
			{ error: "Invalid installation credential." },
			{ status: 401, headers },
		);
	try {
		const { keyHash } = z
			.object({ keyHash: z.string().regex(/^[a-f0-9]{64}$/) })
			.strict()
			.parse(
				JSON.parse(
					new TextDecoder().decode(
						await readBoundedBody({ request, maximumBytes: 1024 }),
					),
				),
			);
		if (await accountDataLocked(credential.accountId))
			return Response.json(
				{ error: "Account data is temporarily locked." },
				{ status: 423, headers },
			);
		await activateMcpInstallation({ credential, keyHash });
		return Response.json({ activated: true }, { headers });
	} catch {
		return Response.json(
			{ error: "Installation is invalid, expired, or already used." },
			{ status: 401, headers },
		);
	}
}
