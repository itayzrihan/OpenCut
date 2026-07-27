import { type NextRequest, NextResponse } from "next/server";
import {
	CHATGPT_CODEX_MODEL_FALLBACKS,
	CHATGPT_CODEX_MODELS,
	DEFAULT_CHATGPT_CODEX_MODEL,
	buildChatGptCodexModelsFromDiscovery,
	normalizeCodexModelId,
} from "@/ai/codex-models";
import {
	getOpenAIOAuthStatus,
	setCredentialsCookie,
} from "@/ai/server/openai-codex-oauth";
import { webEnv } from "@/env/web";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
	const oauth = await getOpenAIOAuthStatus({ request });
	const discoveryEndpoint = getCodexModelsEndpoint();

	if (oauth.status.authenticated && oauth.credentials) {
		try {
			const discoveredModels = await fetchLiveCodexModels({
				accessToken: oauth.credentials.access,
				accountId: oauth.credentials.accountId,
				endpoint: discoveryEndpoint,
			});
			const response = NextResponse.json(
				buildModelsResponse({
					models: discoveredModels,
					liveDiscovery: true,
					source: discoveryEndpoint,
					authenticated: true,
				}),
			);
			if (oauth.refreshedCredentials) {
				setCredentialsCookie({
					response,
					credentials: oauth.refreshedCredentials,
				});
			}
			return response;
		} catch (error) {
			const response = NextResponse.json(
				buildModelsResponse({
					models: CHATGPT_CODEX_MODELS.map((model) => ({
						...model,
						source: "static" as const,
					})),
					liveDiscovery: false,
					source: discoveryEndpoint,
					authenticated: true,
					discoveryError:
						error instanceof Error
							? error.message
							: "OpenAI Codex model discovery failed.",
				}),
			);
			if (oauth.refreshedCredentials) {
				setCredentialsCookie({
					response,
					credentials: oauth.refreshedCredentials,
				});
			}
			return response;
		}
	}

	return NextResponse.json(
		buildModelsResponse({
			models: CHATGPT_CODEX_MODELS.map((model) => ({
				...model,
				source: "static" as const,
			})),
			liveDiscovery: false,
			source: discoveryEndpoint,
			authenticated: false,
			discoveryError: oauth.status.error,
		}),
	);
}

async function fetchLiveCodexModels({
	accessToken,
	accountId,
	endpoint,
}: {
	accessToken: string;
	accountId?: string;
	endpoint: string;
}) {
	const response = await fetch(endpoint, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
			...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
		},
		cache: "no-store",
	});
	if (!response.ok) {
		throw new Error(
			`OpenAI Codex model discovery failed (${response.status}): ${
				(await response.text().catch(() => response.statusText)).slice(
					0,
					240,
				) || response.statusText
			}`,
		);
	}

	const body: unknown = await response.json();
	const models = buildChatGptCodexModelsFromDiscovery(body);
	if (models.length === 0) {
		throw new Error("OpenAI Codex model discovery returned no visible models.");
	}
	return models;
}

function buildModelsResponse({
	models,
	liveDiscovery,
	source,
	authenticated,
	discoveryError,
}: {
	models: typeof CHATGPT_CODEX_MODELS;
	liveDiscovery: boolean;
	source: string;
	authenticated: boolean;
	discoveryError?: string;
}) {
	return {
		models,
		defaultModel: DEFAULT_CHATGPT_CODEX_MODEL,
		configuredModel: webEnv.OPENAI_CODEX_MODEL,
		selectedModel: normalizeCodexModelId(webEnv.OPENAI_CODEX_MODEL),
		fallbackOrder: CHATGPT_CODEX_MODEL_FALLBACKS,
		liveDiscovery,
		authenticated,
		source,
		...(discoveryError ? { discoveryError } : {}),
		note: liveDiscovery
			? "Model rows were discovered from the signed-in ChatGPT Codex account."
			: "Static fallback rows are used until ChatGPT Codex model discovery succeeds. Chat requests still retry supported fallbacks when a configured legacy model is rejected.",
	};
}

function getCodexModelsEndpoint(): string {
	const url = new URL(webEnv.OPENAI_CODEX_RESPONSES_BASE_URL);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
	url.searchParams.set("client_version", "1.0.0");
	return url.toString();
}
