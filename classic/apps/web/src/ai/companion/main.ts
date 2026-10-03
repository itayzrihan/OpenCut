import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import {
	createHash,
	randomBytes,
	createCipheriv,
	createDecipheriv,
} from "node:crypto";
import { createCompanionServer, validatePairing } from "./server";

const configPath =
	process.argv[2] || join(dirname(process.execPath), "OpenCut-AI-Pairing.json");
const pair = validatePairing(JSON.parse(await readFile(configPath, "utf8")));
const root = join(
	process.env.LOCALAPPDATA || join(homedir(), ".local", "share"),
	"OpenCut Client AI",
);
const profile = join(
	root,
	createHash("sha256")
		.update(JSON.stringify([pair.origin, pair.accountId]))
		.digest("hex"),
);
await mkdir(profile, { recursive: true });
// Never inspect or inherit the hosting machine's, Codex's, or another account's credentials.
process.env.OPENCUT_ACCOUNTS_DIR = root;
process.env.OPENCUT_OPENAI_OAUTH_SESSION_DIR = join(profile, "oauth");
Object.assign(process.env, { NODE_ENV: "production" });
process.env.NEXT_PUBLIC_SITE_URL = "http://127.0.0.1:43127";
delete process.env.BETTER_AUTH_SECRET;
const { NextRequest, NextResponse } = await import("next/server");
const oauth = await import("../server/openai-codex-oauth");
const { accountScope } = await import("@/accounts/server");
const { hostCookieSecret } = await import("@/accounts/host-key");
const { handleAiChatRequest } = await import("../server/chat-handler");
const { handleAiModelsRequest } = await import("../server/models-handler");
const key = hostCookieSecret(),
	jarPath = join(profile, "browser-session.enc");
let jar: Record<string, string> = {
	"opencut-account": randomBytes(32).toString("hex"),
};
try {
	const envelope = JSON.parse(await readFile(jarPath, "utf8"));
	const cipher = createDecipheriv(
		"aes-256-gcm",
		key,
		Buffer.from(envelope.iv, "hex"),
	);
	cipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
	jar = JSON.parse(
		Buffer.concat([
			cipher.update(Buffer.from(envelope.data, "hex")),
			cipher.final(),
		]).toString(),
	);
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT")
		throw Error(
			"Local AI session cannot be unlocked. Existing data was preserved.",
		);
}
let writes = Promise.resolve();
function saveJar() {
	const snapshot = JSON.stringify(jar);
	writes = writes
		.catch(() => {})
		.then(async () => {
			const iv = randomBytes(12),
				cipher = createCipheriv("aes-256-gcm", key, iv);
			const data = Buffer.concat([cipher.update(snapshot), cipher.final()]);
			await writeFile(
				jarPath + ".tmp",
				JSON.stringify({
					iv: iv.toString("hex"),
					tag: cipher.getAuthTag().toString("hex"),
					data: data.toString("hex"),
				}),
				{ mode: 0o600 },
			);
			await rename(jarPath + ".tmp", jarPath);
		});
	return writes;
}
async function absorb(response: InstanceType<typeof NextResponse>) {
	for (const cookie of response.cookies.getAll()) {
		if (cookie.value) jar[cookie.name] = cookie.value;
		else delete jar[cookie.name];
	}
	await saveJar();
}
const server = createCompanionServer(
	pair,
	async (path, method, body, signal) => {
		return accountScope.run(
			{
				id: pair.accountId,
				login: "device-owner",
				displayName: "Device owner",
			},
			async () => {
				const request = new NextRequest("http://127.0.0.1:43127" + path, {
					method,
					headers: {
						"Content-Type": "application/json",
						cookie: Object.entries(jar)
							.map(([k, v]) => `${k}=${v}`)
							.join("; "),
					},
					...(body.length ? { body: Buffer.from(body) } : {}),
					signal,
				});
				if (path === "/api/ai/oauth/start") {
					const response = await oauth.createOpenAIAuthorizationResponse({
						request,
					});
					await absorb(response);
					const authorizationUrl = response.headers.get("location") || "";
					if (!authorizationUrl.startsWith("https://auth.openai.com/"))
						return Response.json(
							{
								error:
									"OpenAI sign-in could not start. Close another pending Codex sign-in and try again.",
							},
							{ status: 409 },
						);
					return Response.json({ authorizationUrl });
				}
				if (path.startsWith("/api/ai/oauth/complete?")) {
					const result = await oauth.completeOpenAIAuthorizationHandoff({
						request,
					});
					await absorb(result.response);
					return new Response(
						`<!doctype html><title>OpenCut AI</title><main><h1>${result.success ? "OpenAI connected on this device" : "Sign-in expired"}</h1><p>${result.success ? "Return to your OpenCut tab. Your login stays on this computer." : "Return to OpenCut and restart sign-in."}</p></main>`,
						{
							status: result.success ? 200 : 400,
							headers: {
								"Content-Type": "text/html; charset=utf-8",
								"Content-Security-Policy":
									"default-src 'none'; frame-ancestors 'none'",
							},
						},
					);
				}
				if (path === "/api/ai/oauth/status") {
					const result = await oauth.getOpenAIOAuthStatus({ request });
					return Response.json({ ...result.status, execution: "this-device" });
				}
				if (path === "/api/ai/oauth/logout") {
					const response = NextResponse.json({ ok: true });
					oauth.clearOpenAICredentials({ response, request });
					await absorb(response);
					return Response.json({ ok: true });
				}
				const response =
					path === "/api/ai/chat"
						? await handleAiChatRequest(request)
						: await handleAiModelsRequest(request);
				await absorb(response);
				return response;
			},
		);
	},
);
server.listen(43127, "127.0.0.1", () =>
	console.log(
		`OpenCut AI is ready for ${pair.origin}, account ${pair.accountId}. Return to OpenCut and select Connect. Keep this app running. Close it to stop device access.`,
	),
);
server.on("error", (error) => {
	console.error("OpenCut AI could not start:", error.message);
	process.exitCode = 1;
});
