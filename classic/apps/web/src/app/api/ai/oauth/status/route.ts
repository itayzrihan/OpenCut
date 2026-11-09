import { withAccount } from "@/accounts/server";
import {
	chatGPTStatus,
	requireLocalChatGPT,
} from "@/editor-agent/server/chatgpt";

export const runtime = "nodejs";

export const GET = withAccount(async (request) => {
	const denied = requireLocalChatGPT(request);
	if (denied) return denied;
	const { sharing, identity, error } = await chatGPTStatus();
	return Response.json({
		authenticated: sharing,
		identity: identity && { email: identity.email, profileName: identity.name },
		error,
	});
});
