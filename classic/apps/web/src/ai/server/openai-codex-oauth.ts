import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	randomUUID,
} from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import {
	getCodexModelCandidates,
	isUnsupportedCodexModelError,
	normalizeCodexModelId,
} from "@/ai/codex-models";
import { webEnv } from "@/env/web";

const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const SCOPE = "openid profile email offline_access";
const CODEX_ORIGINATOR = "pi";
const LEGACY_OAUTH_TOKEN_COOKIE = "opencut_openai_oauth_token";
const OAUTH_SESSION_COOKIE = "opencut_openai_oauth_session";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const OAUTH_FLOW_MAX_AGE_MS = 10 * 60 * 1000;
const OAUTH_HANDOFF_MAX_AGE_MS = 2 * 60 * 1000;
const TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const REFRESH_SKEW_MS = 60_000;
const PERSISTED_SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface OpenAICodexCredentials {
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
	email?: string;
	chatgptPlanType?: string;
	profileName?: string;
	sessionBinding: string;
}

interface OAuthState {
	state: string;
	codeVerifier: string;
	redirectUri: string;
	returnTo: string;
	appOrigin: string;
	sessionBinding: string;
	createdAt: number;
}

interface OAuthHandoff {
	credentials: OpenAICodexCredentials;
	returnTo: string;
	sessionBinding: string;
	createdAt: number;
}

interface OAuthRuntimeState {
	server: Server | null;
	serverStart: Promise<void> | null;
	flows: Map<string, OAuthState>;
	handoffs: Map<string, OAuthHandoff>;
	credentialSessions: Map<string, OAuthCredentialSession>;
}

interface OAuthCredentialSession {
	credentials: OpenAICodexCredentials;
	sessionBinding: string;
	createdAt: number;
	updatedAt: number;
}

interface OAuthSessionCookie {
	sessionId: string;
	sessionBinding: string;
}

export interface OAuthStatus {
	authenticated: boolean;
	identity: {
		accountId?: string;
		email?: string;
		chatgptPlanType?: string;
		profileName?: string;
	} | null;
	error?: string;
}

declare global {
	var __opencutOpenAIOAuthRuntime: OAuthRuntimeState | undefined;
}

export async function createOpenAIAuthorizationResponse({
	request,
}: {
	request: NextRequest;
}): Promise<NextResponse> {
	const { verifier, challenge } = createPkcePair();
	const state = randomUUID();
	const redirectUri = resolveLoopbackRedirectUri();
	const returnTo = normalizeReturnTo({
		value: request.nextUrl.searchParams.get("returnTo"),
		origin: request.nextUrl.origin,
	});
	const sessionBinding = getSessionBinding({ request });
	const statePayload: OAuthState = {
		state,
		codeVerifier: verifier,
		redirectUri,
		returnTo,
		appOrigin: request.nextUrl.origin,
		sessionBinding,
		createdAt: Date.now(),
	};

	try {
		await registerOAuthFlow(statePayload);
	} catch (error) {
		return NextResponse.redirect(
			createReturnUrl({
				request,
				status: "error",
				message:
					error instanceof Error
						? error.message
						: "OpenAI OAuth callback server could not start.",
				returnTo,
			}).toString(),
			302,
		);
	}

	return NextResponse.redirect(
		createAuthorizationUrl({
			challenge,
			redirectUri,
			state,
		}).toString(),
		302,
	);
}

export async function completeOpenAIAuthorization({
	request,
}: {
	request: NextRequest;
}): Promise<{ response: NextResponse; success: boolean }> {
	return {
		response: NextResponse.redirect(
			createReturnUrl({
				request,
				status: "error",
				message:
					"OpenAI redirected to the app callback directly. Restart login so OpenCut can use the Codex loopback callback.",
			}).toString(),
			302,
		),
		success: false,
	};
}

export async function completeOpenAIAuthorizationHandoff({
	request,
}: {
	request: NextRequest;
}): Promise<{ response: NextResponse; success: boolean }> {
	const handoffId = request.nextUrl.searchParams.get("handoff");
	const handoff = handoffId ? consumeOAuthHandoff(handoffId) : null;
	if (!handoff) {
		return {
			response: NextResponse.redirect(
				createReturnUrl({
					request,
					status: "error",
					message: "OpenAI OAuth handoff expired. Please try logging in again.",
				}).toString(),
				302,
			),
			success: false,
		};
	}

	if (handoff.sessionBinding !== getSessionBinding({ request })) {
		return {
			response: NextResponse.redirect(
				createReturnUrl({
					request,
					status: "error",
					message: "OpenAI OAuth session changed before login completed.",
					returnTo: handoff.returnTo,
				}).toString(),
				302,
			),
			success: false,
		};
	}

	const response = NextResponse.redirect(
		createReturnUrl({
			request,
			status: "success",
			returnTo: handoff.returnTo,
		}).toString(),
		302,
	);
	setCredentialsCookie({ response, credentials: handoff.credentials });
	return { response, success: true };
}

export async function getOpenAIOAuthStatus({
	request,
}: {
	request: NextRequest;
}): Promise<{
	status: OAuthStatus;
	credentials?: OpenAICodexCredentials;
	refreshedCredentials?: OpenAICodexCredentials;
}> {
	const credentialSession = readCredentialSession({ request });
	if (!credentialSession) {
		return { status: { authenticated: false, identity: null } };
	}

	const { sessionId, credentials } = credentialSession;
	if (credentials.sessionBinding !== getSessionBinding({ request })) {
		return {
			status: {
				authenticated: false,
				identity: null,
				error: "OpenAI login is tied to a different app session.",
			},
		};
	}

	try {
		const refreshedCredentials = await refreshIfNeeded(credentials);
		const activeCredentials = refreshedCredentials ?? credentials;
		if (refreshedCredentials) {
			updateCredentialSession({ sessionId, credentials: refreshedCredentials });
		}
		return {
			status: {
				authenticated: true,
				identity: {
					accountId: activeCredentials.accountId,
					email: activeCredentials.email,
					chatgptPlanType: activeCredentials.chatgptPlanType,
					profileName: activeCredentials.profileName,
				},
			},
			credentials: activeCredentials,
		};
	} catch (error) {
		return {
			status: {
				authenticated: false,
				identity: null,
				error:
					error instanceof Error
						? error.message
						: "OpenAI OAuth refresh failed.",
			},
		};
	}
}

export function setCredentialsCookie({
	response,
	credentials,
}: {
	response: NextResponse;
	credentials: OpenAICodexCredentials;
}): void {
	const sessionId = storeCredentialSession({ credentials });
	setSealedCookie({
		response,
		name: OAUTH_SESSION_COOKIE,
		value: { sessionId, sessionBinding: credentials.sessionBinding },
		maxAge: TOKEN_MAX_AGE_SECONDS,
	});
	clearCookie({ response, name: LEGACY_OAUTH_TOKEN_COOKIE });
}

export function clearOpenAICredentials({
	response,
	request,
}: {
	response: NextResponse;
	request?: NextRequest;
}): void {
	if (request) {
		const sessionCookie = readSessionCookie({ request });
		if (sessionCookie) {
			getOAuthRuntime().credentialSessions.delete(sessionCookie.sessionId);
			deletePersistedCredentialSession(sessionCookie.sessionId);
		}
	}
	clearCookie({ response, name: OAUTH_SESSION_COOKIE });
	clearCookie({ response, name: LEGACY_OAUTH_TOKEN_COOKIE });
}

export async function forwardCodexResponsesRequest({
	credentials,
	body,
	signal,
}: {
	credentials: OpenAICodexCredentials;
	body: Record<string, unknown>;
	signal?: AbortSignal;
}): Promise<unknown> {
	const modelCandidates = getCodexModelCandidates(
		typeof body.model === "string" ? body.model : webEnv.OPENAI_CODEX_MODEL,
	);
	let lastUnsupportedModelMessage = "";

	for (const [modelIndex, model] of modelCandidates.entries()) {
		const requestBody = buildCodexResponsesRequestBody({ body, model });
		const response = await fetch(
			`${webEnv.OPENAI_CODEX_RESPONSES_BASE_URL}/responses`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					Authorization: `Bearer ${credentials.access}`,
					...(credentials.accountId
						? { "chatgpt-account-id": credentials.accountId }
						: {}),
					originator: CODEX_ORIGINATOR,
				},
				body: JSON.stringify(requestBody),
				signal,
			},
		);

		if (!response.ok) {
			const message = await readCodexErrorMessage({ response });
			if (
				modelIndex < modelCandidates.length - 1 &&
				isUnsupportedCodexModelError({
					status: response.status,
					message,
				})
			) {
				lastUnsupportedModelMessage = `${model}: ${message}`;
				continue;
			}
			throw new Error(
				`OpenAI Codex request failed (${response.status}) with ${model}: ${message}`,
			);
		}

		if (isEventStreamResponse(response)) {
			return parseCodexResponsesStream({ response });
		}

		const responseText = await response.text();
		const responseBody = parseCodexResponseText({
			text: responseText,
			contentType: response.headers.get("content-type"),
		});
		if (!responseBody) {
			throw new Error("OpenAI Codex response was empty.");
		}
		return responseBody;
	}

	throw new Error(
		`OpenAI Codex request failed because no ChatGPT Codex model was accepted.${
			lastUnsupportedModelMessage
				? ` Last error: ${lastUnsupportedModelMessage}`
				: ""
		}`,
	);
}

function buildCodexResponsesRequestBody({
	body,
	model,
}: {
	body: Record<string, unknown>;
	model?: string;
}): Record<string, unknown> {
	const { instructions, input } = normalizeResponsesInput(body.input);
	const webSearch = body.webSearch === true;
	const tools = webSearch
		? [{ type: "web_search", search_context_size: "low" }]
		: normalizeResponsesTools(body.tools);
	const selectedModel = normalizeCodexModelId(
		model ??
			(typeof body.model === "string" && body.model.trim()
				? body.model
				: webEnv.OPENAI_CODEX_MODEL),
	);

	return {
		model: selectedModel,
		store: false,
		stream: true,
		reasoning: { effort: "medium" },
		...(instructions ? { instructions } : {}),
		input,
		...(tools ? { tools } : {}),
		...(webSearch ? { include: ["web_search_call.action.sources"] } : {}),
		tool_choice: tools ? "auto" : undefined,
		parallel_tool_calls: true,
	};
}

function normalizeResponsesInput(value: unknown): {
	instructions: string;
	input: unknown[];
} {
	if (!Array.isArray(value)) {
		return { instructions: "", input: [] };
	}

	const instructions: string[] = [];
	const input: unknown[] = [];
	for (const item of value) {
		if (
			isRecord(item) &&
			item.role === "system" &&
			typeof item.content === "string"
		) {
			instructions.push(item.content);
			continue;
		}
		input.push(item);
	}

	return {
		instructions: instructions.join("\n\n").trim(),
		input,
	};
}

function normalizeResponsesTools(value: unknown): unknown[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		return undefined;
	}

	return value.map((tool) => {
		if (!isRecord(tool) || tool.type !== "function") {
			return tool;
		}
		return {
			...tool,
			strict: typeof tool.strict === "boolean" ? tool.strict : null,
		};
	});
}

async function readCodexErrorMessage({
	response,
}: {
	response: Response;
}): Promise<string> {
	const text = await response.text().catch(() => response.statusText);
	const parsed = parseJsonObject(text);
	if (parsed && "error" in parsed) {
		return stringifyErrorValue(parsed.error);
	}
	return text || response.statusText;
}

function isEventStreamResponse(response: Response): boolean {
	return (
		response.headers
			.get("content-type")
			?.toLowerCase()
			.includes("text/event-stream") === true
	);
}

async function parseCodexResponsesStream({
	response,
}: {
	response: Response;
}): Promise<Record<string, unknown>> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error("OpenAI Codex response had no body.");
	}

	const decoder = new TextDecoder();
	let buffer = "";
	const state: CodexStreamState = {
		responseId: undefined,
		outputText: "",
		outputItemsByIndex: new Map(),
		error: undefined,
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			buffer = consumeCodexStreamBuffer({ buffer, state });
		}
		buffer += decoder.decode();
		consumeCodexStreamBuffer({ buffer: `${buffer}\n\n`, state });
	} finally {
		reader.releaseLock();
	}

	if (state.error) {
		throw new Error(state.error);
	}

	const output = [...state.outputItemsByIndex.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, item]) => item);

	return {
		id: state.responseId ?? `codex-${Date.now()}`,
		output,
		output_text: state.outputText,
	};
}

interface CodexStreamOutputItem {
	id?: string;
	call_id?: string;
	type?: string;
	name?: string;
	arguments?: string;
	action?: {
		type?: string;
		query?: string;
		queries?: string[];
		sources?: Array<{ url: string; title?: string }>;
	};
	content?: Array<{
		type?: string;
		text?: string;
		output_text?: string;
		annotations?: Array<{ type: "url_citation"; url: string; title?: string }>;
	}>;
}

interface CodexStreamState {
	responseId?: string;
	outputText: string;
	outputItemsByIndex: Map<number, CodexStreamOutputItem>;
	error?: string;
}

function consumeCodexStreamBuffer({
	buffer,
	state,
}: {
	buffer: string;
	state: CodexStreamState;
}): string {
	let remaining = buffer;
	let separatorIndex = remaining.indexOf("\n\n");
	while (separatorIndex !== -1) {
		const chunk = remaining.slice(0, separatorIndex);
		remaining = remaining.slice(separatorIndex + 2);
		processCodexStreamChunk({ chunk, state });
		separatorIndex = remaining.indexOf("\n\n");
	}
	return remaining;
}

function processCodexStreamChunk({
	chunk,
	state,
}: {
	chunk: string;
	state: CodexStreamState;
}): void {
	const data = chunk
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
	if (!data || data === "[DONE]") return;

	const event = parseJsonObject(data);
	if (!event) return;
	processCodexStreamEvent({ event, state });
}

function processCodexStreamEvent({
	event,
	state,
}: {
	event: Record<string, unknown>;
	state: CodexStreamState;
}): void {
	const type = typeof event.type === "string" ? event.type : "";
	switch (type) {
		case "response.output_text.delta": {
			if (typeof event.delta === "string") {
				state.outputText += event.delta;
			}
			return;
		}
		case "response.output_text.done": {
			if (typeof event.text === "string") {
				state.outputText = event.text;
			}
			return;
		}
		case "response.output_item.added": {
			const outputIndex = getOutputIndex(event);
			const item = normalizeCodexOutputItem(event.item);
			if (item) {
				state.outputItemsByIndex.set(outputIndex, item);
			}
			return;
		}
		case "response.function_call_arguments.delta": {
			const outputIndex = getOutputIndex(event);
			const item = state.outputItemsByIndex.get(outputIndex);
			if (item && typeof event.delta === "string") {
				item.arguments = `${item.arguments ?? ""}${event.delta}`;
			}
			return;
		}
		case "response.function_call_arguments.done": {
			const outputIndex = getOutputIndex(event);
			const item = state.outputItemsByIndex.get(outputIndex);
			if (item && typeof event.arguments === "string") {
				item.arguments = event.arguments;
			}
			return;
		}
		case "response.output_item.done": {
			const outputIndex = getOutputIndex(event);
			const item = normalizeCodexOutputItem(event.item);
			if (item) {
				state.outputItemsByIndex.set(outputIndex, item);
			}
			return;
		}
		case "response.completed":
		case "response.done": {
			const responseValue = isRecord(event.response) ? event.response : null;
			if (typeof responseValue?.id === "string") {
				state.responseId = responseValue.id;
			}
			if (Array.isArray(responseValue?.output)) {
				mergeCompletedResponseOutput({
					output: responseValue.output,
					state,
				});
			}
			if (typeof responseValue?.output_text === "string") {
				state.outputText = responseValue.output_text;
			}
			return;
		}
		case "response.failed": {
			const responseValue = isRecord(event.response) ? event.response : null;
			const errorValue = isRecord(responseValue?.error)
				? responseValue.error
				: event.error;
			state.error = stringifyErrorValue(errorValue);
			return;
		}
		case "error":
			state.error = stringifyErrorValue(event.error ?? event.message ?? event);
			return;
	}
}

function mergeCompletedResponseOutput({
	output,
	state,
}: {
	output: unknown[];
	state: CodexStreamState;
}): void {
	output.forEach((item, index) => {
		const outputItem = normalizeCodexOutputItem(item);
		if (!outputItem) return;
		state.outputItemsByIndex.set(index, outputItem);
		const text = getOutputItemText(outputItem);
		if (text) {
			state.outputText = state.outputText
				? `${state.outputText}\n${text}`
				: text;
		}
	});
}

function parseCodexResponseText({
	text,
	contentType,
}: {
	text: string;
	contentType: string | null;
}): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	const parsed = parseJsonObject(trimmed);
	if (parsed) {
		if (isCodexResponseShape(parsed)) {
			return normalizeCodexResponseObject(parsed);
		}
		return createPlainTextCodexResponse(trimmed);
	}

	if (looksLikeCodexEventStream(trimmed)) {
		return parseCodexResponsesStreamText({ text: trimmed });
	}

	if (looksLikeHtmlResponse({ text: trimmed, contentType })) {
		throw new Error(
			"OpenAI Codex returned an HTML page instead of a model response. The ChatGPT session may need a fresh login.",
		);
	}

	return createPlainTextCodexResponse(trimmed);
}

function createPlainTextCodexResponse(text: string): Record<string, unknown> {
	return {
		id: `codex-text-${Date.now()}`,
		output: [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text }],
			},
		],
		output_text: text,
	};
}

function parseCodexResponsesStreamText({
	text,
}: {
	text: string;
}): Record<string, unknown> {
	const state: CodexStreamState = {
		responseId: undefined,
		outputText: "",
		outputItemsByIndex: new Map(),
		error: undefined,
	};

	if (text.includes("data:")) {
		consumeCodexStreamBuffer({ buffer: `${text}\n\n`, state });
	} else {
		for (const line of text.split(/\r?\n/)) {
			const event = parseJsonObject(line.trim());
			if (event) {
				processCodexStreamEvent({ event, state });
			}
		}
	}

	if (state.error) {
		throw new Error(state.error);
	}

	const output = [...state.outputItemsByIndex.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, item]) => item);

	return {
		id: state.responseId ?? `codex-stream-${Date.now()}`,
		output,
		output_text: state.outputText,
	};
}

function normalizeCodexResponseObject(
	value: Record<string, unknown>,
): Record<string, unknown> {
	if (isRecord(value.response)) {
		return normalizeCodexResponseObject(value.response);
	}

	if (Array.isArray(value.output)) {
		const output = value.output
			.map(normalizeCodexOutputItem)
			.filter((item): item is CodexStreamOutputItem => item !== null);
		const outputText =
			typeof value.output_text === "string"
				? value.output_text
				: output.map(getOutputItemText).filter(Boolean).join("\n").trim();
		return {
			...value,
			output,
			...(outputText ? { output_text: outputText } : {}),
		};
	}

	return value;
}

function isCodexResponseShape(value: Record<string, unknown>): boolean {
	return (
		isRecord(value.response) ||
		typeof value.id === "string" ||
		typeof value.object === "string" ||
		typeof value.status === "string" ||
		typeof value.output_text === "string" ||
		Array.isArray(value.output)
	);
}

function normalizeCodexOutputItem(
	value: unknown,
): CodexStreamOutputItem | null {
	if (!isRecord(value)) return null;
	const type = typeof value.type === "string" ? value.type : undefined;
	if (type === "function_call") {
		return {
			id: typeof value.id === "string" ? value.id : undefined,
			call_id: typeof value.call_id === "string" ? value.call_id : undefined,
			type,
			name: typeof value.name === "string" ? value.name : undefined,
			arguments: typeof value.arguments === "string" ? value.arguments : "",
		};
	}

	if (type === "message") {
		const content = Array.isArray(value.content)
			? value.content
					.map(normalizeCodexContentPart)
					.filter(
						(
							item,
						): item is NonNullable<CodexStreamOutputItem["content"]>[number] =>
							item !== null,
					)
			: undefined;
		return {
			id: typeof value.id === "string" ? value.id : undefined,
			type,
			content,
		};
	}

	if (type === "web_search_call") {
		return {
			id: typeof value.id === "string" ? value.id : undefined,
			type,
			action: normalizeCodexWebSearchAction(value.action),
		};
	}

	return {
		id: typeof value.id === "string" ? value.id : undefined,
		type,
	};
}

function normalizeCodexContentPart(
	value: unknown,
): NonNullable<CodexStreamOutputItem["content"]>[number] | null {
	if (!isRecord(value)) return null;
	const text =
		typeof value.text === "string"
			? value.text
			: typeof value.output_text === "string"
				? value.output_text
				: undefined;
	const annotations = Array.isArray(value.annotations)
		? value.annotations
				.flatMap((annotation) => {
					if (
						!isRecord(annotation) ||
						annotation.type !== "url_citation" ||
						typeof annotation.url !== "string"
					) {
						return [];
					}
					return [
						{
							type: "url_citation" as const,
							url: annotation.url,
							...(typeof annotation.title === "string"
								? { title: annotation.title }
								: {}),
						},
					];
				})
				.slice(0, 20)
		: undefined;
	return {
		type: typeof value.type === "string" ? value.type : undefined,
		...(text ? { text, output_text: text } : {}),
		...(annotations?.length ? { annotations } : {}),
	};
}

function normalizeCodexWebSearchAction(
	value: unknown,
): CodexStreamOutputItem["action"] {
	if (!isRecord(value)) return undefined;
	const sources = Array.isArray(value.sources)
		? value.sources
				.flatMap((source) => {
					if (!isRecord(source) || typeof source.url !== "string") return [];
					return [
						{
							url: source.url,
							...(typeof source.title === "string"
								? { title: source.title }
								: {}),
						},
					];
				})
				.slice(0, 20)
		: undefined;
	return {
		type: typeof value.type === "string" ? value.type : undefined,
		query: typeof value.query === "string" ? value.query : undefined,
		queries: Array.isArray(value.queries)
			? value.queries.filter(
					(query): query is string => typeof query === "string",
				)
			: undefined,
		...(sources?.length ? { sources } : {}),
	};
}

function getOutputItemText(item: CodexStreamOutputItem): string {
	return (item.content ?? [])
		.map((content) => content.text ?? content.output_text ?? "")
		.filter(Boolean)
		.join("\n")
		.trim();
}

function looksLikeCodexEventStream(text: string): boolean {
	if (/(^|\n)\s*data:/.test(text)) {
		return true;
	}
	return text.split(/\r?\n/).some((line) => {
		const event = parseJsonObject(line.trim());
		return (
			typeof event?.type === "string" && event.type.startsWith("response.")
		);
	});
}

function looksLikeHtmlResponse({
	text,
	contentType,
}: {
	text: string;
	contentType: string | null;
}): boolean {
	return (
		contentType?.toLowerCase().includes("text/html") === true ||
		text.startsWith("<!DOCTYPE html") ||
		text.startsWith("<html")
	);
}

function getOutputIndex(event: Record<string, unknown>): number {
	return typeof event.output_index === "number" &&
		Number.isInteger(event.output_index)
		? event.output_index
		: 0;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function stringifyErrorValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (isRecord(value) && typeof value.message === "string") {
		return value.message;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function createAuthorizationUrl({
	challenge,
	redirectUri,
	state,
}: {
	challenge: string;
	redirectUri: string;
	state: string;
}): URL {
	const authorizeUrl = new URL(AUTHORIZE_URL);
	authorizeUrl.searchParams.set("response_type", "code");
	authorizeUrl.searchParams.set(
		"client_id",
		webEnv.OPENAI_CODEX_OAUTH_CLIENT_ID,
	);
	authorizeUrl.searchParams.set("redirect_uri", redirectUri);
	authorizeUrl.searchParams.set("scope", SCOPE);
	authorizeUrl.searchParams.set("code_challenge", challenge);
	authorizeUrl.searchParams.set("code_challenge_method", "S256");
	authorizeUrl.searchParams.set("state", state);
	authorizeUrl.searchParams.set("id_token_add_organizations", "true");
	authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");
	authorizeUrl.searchParams.set("originator", CODEX_ORIGINATOR);
	return authorizeUrl;
}

function resolveLoopbackRedirectUri(
	host = webEnv.OPENAI_CODEX_OAUTH_CALLBACK_HOST,
): string {
	const hostForUrl = host === "::1" ? "[::1]" : host;
	const url = new URL(`http://${hostForUrl}:${CALLBACK_PORT}`);
	url.pathname = CALLBACK_PATH;
	return url.toString();
}

async function registerOAuthFlow(flow: OAuthState): Promise<void> {
	const runtime = getOAuthRuntime();
	cleanupOAuthRuntime(runtime);
	await ensureOAuthCallbackServer(runtime);
	runtime.flows.set(flow.state, flow);
}

function consumeOAuthHandoff(handoffId: string): OAuthHandoff | null {
	const runtime = getOAuthRuntime();
	cleanupOAuthRuntime(runtime);
	const handoff = runtime.handoffs.get(handoffId) ?? null;
	if (handoff) {
		runtime.handoffs.delete(handoffId);
	}
	return handoff;
}

function getOAuthRuntime(): OAuthRuntimeState {
	globalThis.__opencutOpenAIOAuthRuntime ??= {
		server: null,
		serverStart: null,
		flows: new Map(),
		handoffs: new Map(),
		credentialSessions: new Map(),
	};
	globalThis.__opencutOpenAIOAuthRuntime.credentialSessions ??= new Map();
	return globalThis.__opencutOpenAIOAuthRuntime;
}

function storeCredentialSession({
	credentials,
}: {
	credentials: OpenAICodexCredentials;
}): string {
	const runtime = getOAuthRuntime();
	cleanupOAuthRuntime(runtime);
	const sessionId = randomUUID();
	const now = Date.now();
	const session: OAuthCredentialSession = {
		credentials,
		sessionBinding: credentials.sessionBinding,
		createdAt: now,
		updatedAt: now,
	};
	runtime.credentialSessions.set(sessionId, session);
	persistCredentialSession({ sessionId, session });
	return sessionId;
}

function updateCredentialSession({
	sessionId,
	credentials,
}: {
	sessionId: string;
	credentials: OpenAICodexCredentials;
}): void {
	const runtime = getOAuthRuntime();
	const previous = runtime.credentialSessions.get(sessionId);
	const now = Date.now();
	const session: OAuthCredentialSession = {
		credentials,
		sessionBinding: credentials.sessionBinding,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
	};
	runtime.credentialSessions.set(sessionId, session);
	persistCredentialSession({ sessionId, session });
}

async function ensureOAuthCallbackServer(
	runtime: OAuthRuntimeState,
): Promise<void> {
	if (runtime.server?.listening) return;
	if (runtime.serverStart) return runtime.serverStart;

	runtime.serverStart = new Promise<void>((resolve, reject) => {
		const server = createServer((request, response) => {
			void handleOAuthLoopbackCallback({ request, response });
		});
		const fail = (error: Error) => {
			runtime.server = null;
			const host = webEnv.OPENAI_CODEX_OAUTH_CALLBACK_HOST;
			reject(
				new Error(
					`OpenAI OAuth needs ${host}:${CALLBACK_PORT} for the Codex loopback callback, but it could not be opened: ${error.message}`,
				),
			);
		};
		server.once("error", fail);
		server.listen(
			CALLBACK_PORT,
			webEnv.OPENAI_CODEX_OAUTH_CALLBACK_HOST,
			() => {
				server.off("error", fail);
				server.unref?.();
				runtime.server = server;
				resolve();
			},
		);
	});

	try {
		await runtime.serverStart;
	} finally {
		runtime.serverStart = null;
	}
}

async function handleOAuthLoopbackCallback({
	request,
	response,
}: {
	request: IncomingMessage;
	response: ServerResponse;
}): Promise<void> {
	const runtime = getOAuthRuntime();
	cleanupOAuthRuntime(runtime);
	const url = new URL(request.url ?? "/", "http://localhost");
	if (url.pathname !== CALLBACK_PATH) {
		writeOAuthHtml({
			response,
			statusCode: 404,
			message: "OpenAI OAuth callback route not found.",
		});
		return;
	}

	const state = url.searchParams.get("state");
	const flow = state ? runtime.flows.get(state) : null;
	if (!state || !flow) {
		writeOAuthHtml({
			response,
			statusCode: 400,
			message: "OpenAI OAuth state was missing or expired.",
		});
		return;
	}

	runtime.flows.delete(state);
	const providerError = url.searchParams.get("error");
	if (providerError) {
		writeRedirect({
			response,
			url: createReturnUrlFromReturnTo({
				returnTo: flow.returnTo,
				status: "error",
				message: providerError,
			}),
		});
		return;
	}

	const code = url.searchParams.get("code");
	if (!code) {
		writeRedirect({
			response,
			url: createReturnUrlFromReturnTo({
				returnTo: flow.returnTo,
				status: "error",
				message: "OpenAI OAuth callback did not include an authorization code.",
			}),
		});
		return;
	}

	try {
		const credentials = await exchangeAuthorizationCode({
			code,
			codeVerifier: flow.codeVerifier,
			redirectUri: flow.redirectUri,
			sessionBinding: flow.sessionBinding,
		});
		const handoffId = randomUUID();
		runtime.handoffs.set(handoffId, {
			credentials,
			returnTo: flow.returnTo,
			sessionBinding: flow.sessionBinding,
			createdAt: Date.now(),
		});
		writeRedirect({
			response,
			url: createHandoffUrl({
				appOrigin: flow.appOrigin,
				handoffId,
			}),
		});
	} catch (error) {
		writeRedirect({
			response,
			url: createReturnUrlFromReturnTo({
				returnTo: flow.returnTo,
				status: "error",
				message:
					error instanceof Error
						? error.message
						: "OpenAI OAuth token exchange failed.",
			}),
		});
	}
}

function cleanupOAuthRuntime(runtime: OAuthRuntimeState): void {
	const now = Date.now();
	for (const [state, flow] of runtime.flows) {
		if (now - flow.createdAt > OAUTH_FLOW_MAX_AGE_MS) {
			runtime.flows.delete(state);
		}
	}
	for (const [handoffId, handoff] of runtime.handoffs) {
		if (now - handoff.createdAt > OAUTH_HANDOFF_MAX_AGE_MS) {
			runtime.handoffs.delete(handoffId);
		}
	}
	for (const [sessionId, session] of runtime.credentialSessions) {
		if (now - session.updatedAt > TOKEN_MAX_AGE_SECONDS * 1000) {
			runtime.credentialSessions.delete(sessionId);
			deletePersistedCredentialSession(sessionId);
		}
	}
	cleanupPersistedCredentialSessions({ now });
}

function persistCredentialSession({
	sessionId,
	session,
}: {
	sessionId: string;
	session: OAuthCredentialSession;
}): void {
	const path = getPersistedCredentialSessionPath(sessionId);
	mkdirSync(getPersistedCredentialSessionDir(), { recursive: true });
	writeFileSync(path, sealJson(session), {
		encoding: "utf8",
		mode: 0o600,
	});
}

function readPersistedCredentialSession(
	sessionId: string,
): OAuthCredentialSession | null {
	try {
		const value = unsealJson(
			readFileSync(getPersistedCredentialSessionPath(sessionId), "utf8"),
		);
		if (!isOAuthCredentialSession(value)) {
			deletePersistedCredentialSession(sessionId);
			return null;
		}
		if (Date.now() - value.updatedAt > TOKEN_MAX_AGE_SECONDS * 1000) {
			deletePersistedCredentialSession(sessionId);
			return null;
		}
		return value;
	} catch {
		return null;
	}
}

function deletePersistedCredentialSession(sessionId: string): void {
	try {
		rmSync(getPersistedCredentialSessionPath(sessionId), { force: true });
	} catch {
		// Best effort cleanup only.
	}
}

function cleanupPersistedCredentialSessions({ now }: { now: number }): void {
	const dir = getPersistedCredentialSessionDir();
	if (!existsSync(dir)) return;

	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const sessionId = entry.name.slice(0, -".json".length);
		if (!isCredentialSessionId(sessionId)) {
			rmSync(join(dir, entry.name), { force: true });
			continue;
		}
		try {
			const value = unsealJson(readFileSync(join(dir, entry.name), "utf8"));
			if (
				!isOAuthCredentialSession(value) ||
				now - value.updatedAt > TOKEN_MAX_AGE_SECONDS * 1000
			) {
				rmSync(join(dir, entry.name), { force: true });
			}
		} catch {
			rmSync(join(dir, entry.name), { force: true });
		}
	}
}

function getPersistedCredentialSessionDir(): string {
	return (
		process.env.OPENCUT_OPENAI_OAUTH_SESSION_DIR ??
		join(process.cwd(), ".next", "cache", "openai-oauth-sessions")
	);
}

function getPersistedCredentialSessionPath(sessionId: string): string {
	if (!isCredentialSessionId(sessionId)) {
		throw new Error("Invalid OpenAI OAuth session id.");
	}
	return join(getPersistedCredentialSessionDir(), `${sessionId}.json`);
}

function createHandoffUrl({
	appOrigin,
	handoffId,
}: {
	appOrigin: string;
	handoffId: string;
}): URL {
	const url = new URL("/api/ai/oauth/complete", appOrigin);
	url.searchParams.set("handoff", handoffId);
	return url;
}

function createReturnUrlFromReturnTo({
	returnTo,
	status,
	message,
}: {
	returnTo: string;
	status: "success" | "error";
	message?: string;
}): URL {
	const url = new URL(returnTo);
	url.searchParams.set("ai_oauth", status);
	if (message) {
		url.searchParams.set("ai_oauth_error", message);
	}
	return url;
}

function writeRedirect({
	response,
	url,
}: {
	response: ServerResponse;
	url: URL;
}): void {
	response.statusCode = 302;
	response.setHeader("Location", url.toString());
	response.end();
}

function writeOAuthHtml({
	response,
	statusCode,
	message,
}: {
	response: ServerResponse;
	statusCode: number;
	message: string;
}): void {
	response.statusCode = statusCode;
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.end(
		`<!doctype html><title>OpenAI OAuth</title><main style="font-family:system-ui;padding:24px"><h1>OpenAI OAuth</h1><p>${escapeHtml(message)}</p></main>`,
	);
}

async function exchangeAuthorizationCode({
	code,
	codeVerifier,
	redirectUri,
	sessionBinding,
}: {
	code: string;
	codeVerifier: string;
	redirectUri: string;
	sessionBinding: string;
}): Promise<OpenAICodexCredentials> {
	const json = await postTokenForm({
		grant_type: "authorization_code",
		client_id: webEnv.OPENAI_CODEX_OAUTH_CLIENT_ID,
		code,
		code_verifier: codeVerifier,
		redirect_uri: redirectUri,
	});
	return normalizeTokenResponse({ json, sessionBinding });
}

async function refreshIfNeeded(
	credentials: OpenAICodexCredentials,
): Promise<OpenAICodexCredentials | null> {
	if (Date.now() + REFRESH_SKEW_MS < credentials.expires) {
		return null;
	}
	const json = await postTokenForm({
		grant_type: "refresh_token",
		refresh_token: credentials.refresh,
		client_id: webEnv.OPENAI_CODEX_OAUTH_CLIENT_ID,
	});
	return normalizeTokenResponse({
		json,
		sessionBinding: credentials.sessionBinding,
	});
}

async function postTokenForm(
	body: Record<string, string>,
): Promise<Record<string, unknown>> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => response.statusText);
		throw new Error(
			`OpenAI Codex token request failed (${response.status}): ${text}`,
		);
	}
	const json: unknown = await response.json();
	if (!isRecord(json)) {
		throw new Error("OpenAI Codex token response was not an object.");
	}
	return json;
}

function normalizeTokenResponse({
	json,
	sessionBinding,
}: {
	json: Record<string, unknown>;
	sessionBinding: string;
}): OpenAICodexCredentials {
	const access = typeof json.access_token === "string" ? json.access_token : "";
	const refresh =
		typeof json.refresh_token === "string" ? json.refresh_token : "";
	const expiresIn =
		typeof json.expires_in === "number" && Number.isFinite(json.expires_in)
			? json.expires_in
			: 0;
	if (!access || !refresh || expiresIn <= 0) {
		throw new Error("OpenAI Codex token response was missing required fields.");
	}
	const identity = resolveCodexAuthIdentity({ accessToken: access });
	return {
		access,
		refresh,
		expires: Date.now() + expiresIn * 1000,
		sessionBinding,
		...identity,
	};
}

function createPkcePair(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

function setSealedCookie({
	response,
	name,
	value,
	maxAge,
}: {
	response: NextResponse;
	name: string;
	value: unknown;
	maxAge: number;
}): void {
	response.cookies.set(name, sealJson(value), {
		httpOnly: true,
		sameSite: "lax",
		secure: webEnv.NEXT_PUBLIC_SITE_URL.startsWith("https://"),
		path: "/",
		maxAge,
	});
}

function readSealedCookie({
	request,
	name,
}: {
	request: NextRequest;
	name: string;
}): unknown | null {
	const value = request.cookies.get(name)?.value;
	if (!value) return null;
	try {
		return unsealJson(value);
	} catch {
		return null;
	}
}

function readSessionCookie({
	request,
}: {
	request: NextRequest;
}): OAuthSessionCookie | null {
	const value = readSealedCookie({ request, name: OAUTH_SESSION_COOKIE });
	return isOAuthSessionCookie(value) ? value : null;
}

function readCredentialSession({
	request,
}: {
	request: NextRequest;
}): { sessionId: string; credentials: OpenAICodexCredentials } | null {
	const sessionCookie = readSessionCookie({ request });
	if (!sessionCookie) return null;

	const sessionBinding = getSessionBinding({ request });
	if (sessionCookie.sessionBinding !== sessionBinding) {
		return null;
	}

	const runtime = getOAuthRuntime();
	cleanupOAuthRuntime(runtime);
	const session =
		runtime.credentialSessions.get(sessionCookie.sessionId) ??
		readPersistedCredentialSession(sessionCookie.sessionId);
	if (!session || session.sessionBinding !== sessionBinding) {
		return null;
	}

	const now = Date.now();
	const previousUpdatedAt = session.updatedAt;
	session.updatedAt = now;
	runtime.credentialSessions.set(sessionCookie.sessionId, session);
	if (now - previousUpdatedAt > PERSISTED_SESSION_TOUCH_INTERVAL_MS) {
		persistCredentialSession({ sessionId: sessionCookie.sessionId, session });
	}
	return {
		sessionId: sessionCookie.sessionId,
		credentials: session.credentials,
	};
}

function clearCookie({
	response,
	name,
}: {
	response: NextResponse;
	name: string;
}): void {
	response.cookies.set(name, "", {
		httpOnly: true,
		sameSite: "lax",
		secure: webEnv.NEXT_PUBLIC_SITE_URL.startsWith("https://"),
		path: "/",
		maxAge: 0,
	});
}

function sealJson(value: unknown): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", getCookieKey(), iv);
	const plaintext = Buffer.from(JSON.stringify(value), "utf8");
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return base64url(
		Buffer.from(
			JSON.stringify({
				v: 1,
				iv: base64url(iv),
				tag: base64url(tag),
				data: base64url(encrypted),
			}),
			"utf8",
		),
	);
}

function unsealJson(sealed: string): unknown {
	const parsedEnvelope: unknown = JSON.parse(
		Buffer.from(sealed, "base64url").toString("utf8"),
	);
	if (!isSealedEnvelope(parsedEnvelope)) {
		throw new Error("Invalid sealed cookie envelope");
	}
	const decipher = createDecipheriv(
		"aes-256-gcm",
		getCookieKey(),
		Buffer.from(parsedEnvelope.iv, "base64url"),
	);
	decipher.setAuthTag(Buffer.from(parsedEnvelope.tag, "base64url"));
	const decrypted = Buffer.concat([
		decipher.update(Buffer.from(parsedEnvelope.data, "base64url")),
		decipher.final(),
	]);
	return JSON.parse(decrypted.toString("utf8"));
}

function getCookieKey(): Buffer {
	return createHash("sha256").update(webEnv.BETTER_AUTH_SECRET).digest();
}

function getSessionBinding({ request }: { request: NextRequest }): string {
	const sessionCookie =
		request.cookies.get("better-auth.session_token")?.value ??
		request.cookies.get("__Secure-better-auth.session_token")?.value ??
		request.cookies.get("better-auth.session-token")?.value ??
		"sessionless";
	return createHash("sha256").update(sessionCookie).digest("base64url");
}

function normalizeReturnTo({
	value,
	origin,
}: {
	value: string | null;
	origin: string;
}): string {
	if (!value) return origin;
	try {
		const parsed = new URL(value, origin);
		return parsed.origin === origin ? parsed.toString() : origin;
	} catch {
		return origin;
	}
}

function createReturnUrl({
	request,
	status,
	message,
	returnTo,
}: {
	request: NextRequest;
	status: "success" | "error";
	message?: string;
	returnTo?: string;
}): URL {
	const url = new URL(returnTo ?? request.nextUrl.origin);
	url.searchParams.set("ai_oauth", status);
	if (message) {
		url.searchParams.set("ai_oauth_error", message);
	}
	return url;
}

function resolveCodexAuthIdentity({
	accessToken,
}: {
	accessToken: string;
}): Pick<
	OpenAICodexCredentials,
	"accountId" | "email" | "chatgptPlanType" | "profileName"
> {
	const payload = decodeJwtPayload(accessToken);
	const auth = asRecord(payload?.["https://api.openai.com/auth"]);
	const profile = asRecord(payload?.["https://api.openai.com/profile"]);
	const email = trimNonEmptyString(profile?.email);
	const accountId = trimNonEmptyString(auth?.chatgpt_account_id);
	const chatgptPlanType = trimNonEmptyString(auth?.chatgpt_plan_type);
	const subject =
		trimNonEmptyString(auth?.chatgpt_account_user_id) ??
		trimNonEmptyString(auth?.chatgpt_user_id) ??
		trimNonEmptyString(auth?.user_id) ??
		trimNonEmptyString(payload?.sub);
	return {
		...(accountId ? { accountId } : {}),
		...(email ? { email, profileName: email } : {}),
		...(chatgptPlanType ? { chatgptPlanType } : {}),
		...(!email && subject
			? { profileName: `id-${Buffer.from(subject).toString("base64url")}` }
			: {}),
	};
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const [, payload] = token.split(".");
	if (!payload) return null;
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function isSealedEnvelope(value: unknown): value is {
	iv: string;
	tag: string;
	data: string;
} {
	return (
		isRecord(value) &&
		typeof value.iv === "string" &&
		typeof value.tag === "string" &&
		typeof value.data === "string"
	);
}

function isOAuthSessionCookie(value: unknown): value is OAuthSessionCookie {
	return (
		isRecord(value) &&
		typeof value.sessionId === "string" &&
		typeof value.sessionBinding === "string"
	);
}

function isOAuthCredentialSession(
	value: unknown,
): value is OAuthCredentialSession {
	return (
		isRecord(value) &&
		isOpenAICodexCredentials(value.credentials) &&
		typeof value.sessionBinding === "string" &&
		typeof value.createdAt === "number" &&
		Number.isFinite(value.createdAt) &&
		typeof value.updatedAt === "number" &&
		Number.isFinite(value.updatedAt)
	);
}

function isOpenAICodexCredentials(
	value: unknown,
): value is OpenAICodexCredentials {
	return (
		isRecord(value) &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires) &&
		typeof value.sessionBinding === "string" &&
		(value.accountId === undefined || typeof value.accountId === "string") &&
		(value.email === undefined || typeof value.email === "string") &&
		(value.chatgptPlanType === undefined ||
			typeof value.chatgptPlanType === "string") &&
		(value.profileName === undefined || typeof value.profileName === "string")
	);
}

function isCredentialSessionId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		value,
	);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function trimNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function base64url(value: Buffer): string {
	return value.toString("base64url");
}

function escapeHtml(value: string): string {
	return value.replaceAll(/[&<>"']/g, (character) => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

function resetOAuthRuntimeForTests(): void {
	globalThis.__opencutOpenAIOAuthRuntime = undefined;
}

export const testing = {
	createPkcePair,
	createAuthorizationUrl,
	resolveCodexAuthIdentity,
	resolveLoopbackRedirectUri,
	normalizeReturnTo,
	storeCredentialSession,
	readSessionCookie,
	resetOAuthRuntimeForTests,
	buildCodexResponsesRequestBody,
	parseCodexResponsesStream,
	parseCodexResponseText,
	parseCodexResponsesStreamText,
};
