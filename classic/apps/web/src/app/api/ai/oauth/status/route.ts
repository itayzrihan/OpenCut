import { withAccount } from "@/accounts/server";
import {
	agentProviderStatus,
	requireAgentOrigin,
} from "@/editor-agent/server/provider";

export const runtime = "nodejs";

export const GET = withAccount(async (request) => {
	const denied = requireAgentOrigin(request);
	if (denied) return denied;
	const { sharing, identity, error } = await agentProviderStatus();
	return Response.json({
		authenticated: sharing,
		identity: identity && { email: identity.email, profileName: identity.name },
		error,
	});
});
