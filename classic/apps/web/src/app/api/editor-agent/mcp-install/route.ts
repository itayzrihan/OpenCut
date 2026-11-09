import {
	assertLocalOrigin,
	requireAccount,
	withAccount,
} from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import { getProject } from "@/services/local-drive/server";
import { findDelegatedBridge } from "@/mcp/server/delegated-bridge";
import {
	issueMcpInstallation,
	mcpLocalOrigin,
	revokeMcpInstallation,
} from "@/mcp/server/delegation";
import { z } from "zod";

export const runtime = "nodejs";

export const POST = withAccount(async (request) => {
	let origin: string;
	try {
		assertLocalOrigin(request);
		origin = mcpLocalOrigin(request);
	} catch {
		return Response.json(
			{ error: "Create the MCP package in a local POCUT installation." },
			{ status: 403 },
		);
	}
	try {
		const { action, projectId } = z
			.object({
				action: z.enum(["issue", "revoke"]),
				projectId: z.string().regex(/^[\w-]{1,128}$/),
			})
			.strict()
			.parse(
				JSON.parse(
					new TextDecoder().decode(
						await readBoundedBody({ request, maximumBytes: 1024 }),
					),
				),
			);
		const accountId = requireAccount().id;
		if (action === "revoke") {
			await revokeMcpInstallation({ accountId, projectId });
			return Response.json({ revoked: true });
		}
		if (!(await getProject(projectId)))
			return Response.json(
				{ error: "Save the project before creating an installation." },
				{ status: 404 },
			);
		const target = await findDelegatedBridge({
			accountId,
			projectId,
			signal: request.signal,
		}).catch(() => null);
		if (!target)
			return Response.json(
				{
					error:
						"Keep the saved project open in an updated local POCUT installation with its MCP bridge running.",
				},
				{ status: 503 },
			);
		await target.inventory.body?.cancel();
		return Response.json({
			...(await issueMcpInstallation({ accountId, projectId })),
			origin,
		});
	} catch {
		return Response.json(
			{ error: "Could not update the MCP installation." },
			{ status: 400 },
		);
	}
});
