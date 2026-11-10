import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { accountDataRoot, accountScope } from "@/accounts/server";
import { notifyAccountDisconnect } from "@/accounts/lifecycle";
import * as vault from "@/generative/server/vault";
import {
	connectHostedProvider,
	disconnectHostedProvider,
	hostedProviderModels,
	hostedProviderStatus,
	streamHostedProvider,
} from "../server/hosted-provider";
import { requireAgentOrigin } from "../server/provider";
import { readAgentResponse } from "../stream";
import { mockFetch } from "@/test-support/mock-fetch";

test("hosted AI requires separate paid authorization, isolates accounts, and relays only bounded text/tool requests", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pocut-hosted-ai-"));
	const saved = {
		root: process.env.OPENCUT_ACCOUNTS_DIR,
		hosted: process.env.OPENCUT_LEGITATE_HOSTED,
		origin: process.env.OPENCUT_PUBLIC_ORIGIN,
		fetch: globalThis.fetch,
	};
	process.env.OPENCUT_ACCOUNTS_DIR = directory;
	process.env.OPENCUT_LEGITATE_HOSTED = "true";
	process.env.OPENCUT_PUBLIC_ORIGIN = "https://pocut.test";
	const account = { id: "alice", login: "alice", displayName: "Alice" };
	const controller = new AbortController();
	const model = {
		id: "test/vision",
		name: "Test vision",
		supported_parameters: ["tools"],
		architecture: {
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
		},
		endpoints: ["/api/v1/responses"],
	};
	let paid = 0,
		fail = false;
	globalThis.fetch = mockFetch(async (url, options) => {
		expect(new Headers(options?.headers).get("authorization")).toBe(
			"Bearer synthetic-user-api-key",
		);
		expect(options?.redirect).toBe("error");
		if (String(url) === "https://openrouter.ai/api/v1/models/user")
			return Response.json({
				data: [
					model,
					{
						...model,
						id: "text-only",
						architecture: {
							input_modalities: ["text"],
							output_modalities: ["text"],
						},
					},
					{ ...model, id: "image-only", supported_parameters: [] },
				],
			});
		expect(String(url)).toBe("https://openrouter.ai/api/v1/responses");
		paid++;
		const body = JSON.parse(String(options?.body));
		expect(body).toMatchObject({
			model: model.id,
			stream: true,
			store: false,
			max_output_tokens: 4096,
			tools: [{ type: "function", name: "opencut_editor" }],
			provider: { allow_fallbacks: false },
		});
		expect(body).not.toHaveProperty("include");
		expect(body).not.toHaveProperty("reasoning");
		if (fail) return new Response("unavailable", { status: 503 });
		return new Response(
			`data: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [] } })}\n\n`,
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	});
	const request = {
		body: {
			model: model.id,
			input: [{ role: "user", content: "Edit" }],
			tools: [{ type: "function", name: "opencut_editor" }],
			include: ["reasoning.encrypted_content"],
			reasoning: { summary: "auto" },
		},
		signal: controller.signal,
	};
	try {
		await accountScope.run(account, async () => {
			expect((await hostedProviderStatus()).sharing).toBe(false);
			await expect(
				connectHostedProvider({
					pin: "123456",
					apiKey: "synthetic-user-api-key",
					confirmed: false,
				}),
			).rejects.toThrow("Confirm");
			await vault.setup({
				root: join(accountDataRoot(), "generative"),
				pin: "123456",
				key: "synthetic-user-api-key",
			});
			await vault.unlock({
				root: join(accountDataRoot(), "generative"),
				pin: "123456",
			});
			await expect(streamHostedProvider(request)).rejects.toThrow("Unlock");
			expect(paid).toBe(0);
			await connectHostedProvider({ pin: "123456", confirmed: true });
			expect((await hostedProviderStatus()).sharing).toBe(true);
			expect(await hostedProviderModels()).toEqual([
				{ id: model.id, name: model.name },
			]);
			const bytes = await readFile(
				join(accountDataRoot(), "generative", "vault.json"),
				"utf8",
			);
			expect(bytes).not.toContain("synthetic-user-api-key");
			expect(JSON.stringify(await hostedProviderStatus())).not.toContain(
				"synthetic-user-api-key",
			);
			expect(
				requireAgentOrigin(
					new Request("https://pocut.test/api/editor-agent/respond", {
						headers: {
							Origin: "https://evil.test",
							"X-Forwarded-Proto": "https",
							Host: "pocut.test",
						},
					}),
				)?.status,
			).toBe(403);
			expect(
				requireAgentOrigin(
					new Request("https://pocut.test/api/editor-agent/respond", {
						headers: {
							Origin: "https://pocut.test",
							"X-Forwarded-Proto": "https",
							Host: "pocut.test",
						},
					}),
				),
			).toBeUndefined();
			await expect(
				streamHostedProvider({
					...request,
					body: { ...request.body, model: "unlisted" },
				}),
			).rejects.toThrow("Choose");
			await expect(
				streamHostedProvider({
					...request,
					body: { ...request.body, tools: [{ type: "web_search" }] },
				}),
			).rejects.toThrow("function tools");
			expect(paid).toBe(0);
			const response = await streamHostedProvider(request);
			expect(response.headers.get("X-OpenCut-Provider-Retry")).toBe("never");
			expect(
				await readAgentResponse({
					response,
					signal: controller.signal,
					onEvent() {},
				}),
			).toMatchObject({ status: "completed" });
			expect(paid).toBe(1);
			expect((await hostedProviderStatus()).remainingRequests).toBe(39);
			fail = true;
			await expect(streamHostedProvider(request)).rejects.toThrow(
				"No paid retry",
			);
			expect(paid).toBe(2);
			await accountScope.run({ ...account, id: "bob" }, async () => {
				expect((await hostedProviderStatus()).connected).toBe(false);
				await expect(streamHostedProvider(request)).rejects.toThrow("Unlock");
			});
			fail = false;
			for (let requestNumber = 2; requestNumber < 40; requestNumber++) {
				await (await streamHostedProvider(request)).text();
			}
			expect(paid).toBe(40);
			expect(await hostedProviderStatus()).toMatchObject({
				sharing: false,
				remainingRequests: 0,
			});
			await expect(streamHostedProvider(request)).rejects.toThrow("40-request");
			expect(paid).toBe(40);
			disconnectHostedProvider();
			expect((await hostedProviderStatus()).sharing).toBe(false);
			await expect(streamHostedProvider(request)).rejects.toThrow("Unlock");
			expect(paid).toBe(40);
			await connectHostedProvider({ pin: "123456", confirmed: true });
			notifyAccountDisconnect(account.id);
			expect((await hostedProviderStatus()).sharing).toBe(false);
			await expect(streamHostedProvider(request)).rejects.toThrow("Unlock");
		});
	} finally {
		globalThis.fetch = saved.fetch;
		for (const [name, value] of [
			["OPENCUT_ACCOUNTS_DIR", saved.root],
			["OPENCUT_LEGITATE_HOSTED", saved.hosted],
			["OPENCUT_PUBLIC_ORIGIN", saved.origin],
		]) {
			if (value === undefined) delete process.env[name!];
			else process.env[name!] = value;
		}
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);
