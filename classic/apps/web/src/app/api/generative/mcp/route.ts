import { join } from "node:path";
import {
	withAccount,
	accountDataRoot,
	assertLocalOrigin,
} from "@/accounts/server";
import { mcpRequest } from "@/generative/server/mcp";
import { requestBytes } from "@/generative/server/request";
import { share } from "@/generative/server/shares";
export const runtime = "nodejs";
/** Only a logged-in editor host can call this. No setup, key, PIN or approval. */
export const POST = withAccount(async (request: Request) => {
	try {
		assertLocalOrigin(request);
		const raw = JSON.parse(
			new TextDecoder().decode(
				await requestBytes({ request, limit: 17_000_000 }),
			),
		);
		const result = await mcpRequest({
			root: join(accountDataRoot(), "generative"),
			raw,
			referenceUrl: (r) => share({ projectId: raw.projectId, reference: r }),
		});
		return Response.json(result);
	} catch (e) {
		return Response.json(
			{ error: e instanceof Error ? e.message : "Director MCP request failed" },
			{ status: 400 },
		);
	}
});
