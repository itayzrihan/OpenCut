import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { accountDataRoot, accountScope } from "@/accounts/server";
import { hostCookieSecret } from "@/accounts/host-key";
import { ChatGPTVault } from "@/editor-agent/server/chatgpt-vault";
import { chatGPTStatus } from "@/editor-agent/server/chatgpt";
import { mockFetch } from "@/test-support/mock-fetch";
import { handleAiChatRequest } from "../server/chat-handler";
import { handleAiModelsRequest } from "../server/models-handler";

test("AI models and requests share the Agent vault and reject remote or disconnected use", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-shared-connection-"));
	const previousRoot = process.env.OPENCUT_ACCOUNTS_DIR;
	const previousFetch = globalThis.fetch;
	process.env.OPENCUT_ACCOUNTS_DIR = root;
	const account = { id: "alice", login: "alice", displayName: "Alice" };
	const local = "http://127.0.0.1:3100";
	const chat = (origin: string) =>
		handleAiChatRequest(
			new NextRequest(origin + "/api/ai/chat", {
				method: "POST",
				body: JSON.stringify({
					model: "gpt-test",
					reasoningEffort: "high",
					input: [
						{ role: "system", content: "Edit only after approval." },
						{ role: "user", content: "Hello" },
					],
				}),
			}),
		);
	let upstreamRequests = 0;
	globalThis.fetch = mockFetch(async (input, init) => {
		upstreamRequests++;
		const url = String(input);
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer synthetic-agent-token",
		);
		if (url === "https://api.openai.com/v1/models") {
			return Response.json({
				models: [
					{
						slug: "gpt-test",
						display_name: "GPT Test",
						visibility: "list",
						supported_reasoning_levels: ["low", "high"],
						default_reasoning_level: "low",
					},
				],
			});
		}
		expect(url).toBe("https://api.openai.com/v1/responses");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			model: "gpt-test",
			stream: true,
			store: false,
			instructions: "Edit only after approval.",
			input: [{ role: "user", content: "Hello" }],
			reasoning: { effort: "high" },
		});
		const result = {
			id: "result",
			status: "completed",
			output: [],
			output_text: "Hello",
		};
		return new Response(
			`data: ${JSON.stringify({ type: "response.completed", response: result })}\n\n`,
			{
				headers: { "Content-Type": "text/event-stream" },
			},
		);
	});
	try {
		await accountScope.run(account, async () => {
			expect((await chat(local)).status).toBe(401);
			expect(upstreamRequests).toBe(0);
			const vault = new ChatGPTVault({
				directory: join(accountDataRoot(), "editor-agent", "chatgpt"),
				accountId: account.id,
				key: hostCookieSecret(),
			});
			await vault.locked((store) =>
				store.write({
					version: 1,
					clientId: "test-client",
					subject: "test-subject",
					accessToken: "synthetic-agent-token",
					expiresAt: Date.now() + 120_000,
					scopes: ["chatgpt.tokens.use.direct", "resource.invoke"],
				}),
			);
			expect((await chatGPTStatus()).sharing).toBe(true);
			expect((await chat("https://public.example")).status).toBe(403);
			expect(upstreamRequests).toBe(0);
			const models = await handleAiModelsRequest(
				new Request(local + "/api/ai/models"),
			);
			expect(await models.json()).toEqual({
				authenticated: true,
				models: [
					{
						id: "gpt-test",
						name: "GPT Test",
						reasoningEfforts: ["low", "high"],
						defaultReasoningEffort: "low",
					},
				],
			});
			const reply = await chat(local);
			expect(reply.status).toBe(200);
			expect(await reply.json()).toMatchObject({
				response: { output_text: "Hello" },
			});
			expect(upstreamRequests).toBe(2);
		});
		await accountScope.run({ ...account, id: "bob" }, async () => {
			expect((await chat(local)).status).toBe(401);
		});
		expect(upstreamRequests).toBe(2);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousRoot === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});
