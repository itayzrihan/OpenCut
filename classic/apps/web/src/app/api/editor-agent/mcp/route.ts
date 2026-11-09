import { accountDataLocked } from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import { fetchBridge } from "@/mcp/server/classic-bridge";
import { findDelegatedBridge } from "@/mcp/server/delegated-bridge";
import {
	authorizeMcpKey,
	mcpLocalOrigin,
	parseMcpCredential,
} from "@/mcp/server/delegation";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
};

async function delegate(request: Request) {
	try {
		mcpLocalOrigin(request);
		if (request.headers.has("origin")) throw new Error();
	} catch {
		return Response.json(
			{ error: "Connect using the local POCUT host or a private SSH forward." },
			{ status: 403, headers },
		);
	}
	const credential = parseMcpCredential(
		request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "",
		"key",
	);
	const projectId =
		credential && (await authorizeMcpKey(credential).catch(() => null));
	if (!credential || !projectId)
		return Response.json(
			{ error: "The POCUT MCP key is invalid or revoked." },
			{ status: 401, headers },
		);
	if (await accountDataLocked(credential.accountId))
		return Response.json(
			{ error: "Account data is temporarily locked." },
			{ status: 423, headers },
		);

	let body: ArrayBuffer | undefined;
	if (request.method === "POST") {
		try {
			body = await readBoundedBody({ request, maximumBytes: 4 * 1024 * 1024 });
			z.object({
				name: z.string().min(1).max(160),
				arguments: z.record(z.string(), z.unknown()).optional(),
			})
				.strict()
				.parse(JSON.parse(new TextDecoder().decode(body)));
		} catch {
			return Response.json(
				{ error: "Invalid or oversized editor command." },
				{ status: 400, headers },
			);
		}
	}
	try {
		const target = await findDelegatedBridge({
			accountId: credential.accountId,
			projectId,
			signal: request.signal,
		});
		if (!target)
			return Response.json(
				{ error: "Open the linked POCUT project." },
				{ status: 503, headers },
			);
		let result = target.inventory;
		if (body) {
			await result.body?.cancel();
			result = await fetchBridge({
				config: target.config,
				path: target.path,
				method: "POST",
				contentType: "application/json",
				body,
				timeoutMs: 245_000,
				signal: request.signal,
			});
		}
		return new Response(result.body, {
			status: result.status,
			headers: { ...headers, "Content-Type": "application/json" },
		});
	} catch {
		return Response.json(
			{ error: "The POCUT editor bridge is unavailable." },
			{ status: 503, headers },
		);
	}
}

export const GET = delegate;
export const POST = delegate;
