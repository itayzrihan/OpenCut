import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { accountScope } from "@/accounts/server";
import {
	connectHostedProvider,
	disconnectHostedProvider,
} from "@/editor-agent/server/hosted-provider";
import { mockFetch } from "@/test-support/mock-fetch";
import { handleAiChatRequest } from "../server/chat-handler";

test("hosted Director uses the selected OpenRouter model and never retries a paid request", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pocut-hosted-director-"));
	const previous = {
		root: process.env.OPENCUT_ACCOUNTS_DIR,
		hosted: process.env.OPENCUT_LEGITATE_HOSTED,
		origin: process.env.OPENCUT_PUBLIC_ORIGIN,
		fetch: globalThis.fetch,
	};
	process.env.OPENCUT_ACCOUNTS_DIR = directory;
	process.env.OPENCUT_LEGITATE_HOSTED = "true";
	process.env.OPENCUT_PUBLIC_ORIGIN = "https://pocut.test";
	const account = {
		id: "director-alice",
		login: "alice",
		displayName: "Alice",
	};
	const selected = "test/vision-selected";
	const requests: Record<string, unknown>[] = [];
	let fail = false;
	globalThis.fetch = mockFetch(async (url, init) => {
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer synthetic-director-key",
		);
		if (String(url) === "https://openrouter.ai/api/v1/models/user")
			return Response.json({
				data: ["test/vision-first", selected].map((id) => ({
					id,
					name: id,
					architecture: {
						input_modalities: ["text", "image"],
						output_modalities: ["text"],
					},
					supported_parameters: ["tools"],
					endpoints: ["/api/v1/responses"],
				})),
			});
		expect(String(url)).toBe("https://openrouter.ai/api/v1/responses");
		requests.push(JSON.parse(String(init?.body)));
		if (fail) return new Response("unavailable", { status: 503 });
		return new Response(
			`data: ${JSON.stringify({ type: "response.completed", response: { id: "director-result", status: "completed", output: [], output_text: "Scene plan" } })}\n\n`,
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	});
	const chat = (model?: string) =>
		handleAiChatRequest(
			new NextRequest("https://pocut.test/api/ai/chat", {
				method: "POST",
				headers: { Origin: "https://pocut.test", Host: "pocut.test" },
				body: JSON.stringify({
					...(model ? { model } : {}),
					input: [
						{
							role: "system",
							content: "Prepare a scene plan from the references.",
						},
						{
							role: "user",
							content: [{ type: "input_text", text: "Plan four scenes." }],
						},
					],
					tools: [],
				}),
			}),
		);
	try {
		await accountScope.run(account, async () => {
			expect((await chat(selected)).status).toBe(401);
			expect(requests).toHaveLength(0);
			await connectHostedProvider({
				pin: "123456",
				apiKey: "synthetic-director-key",
				confirmed: true,
			});
			const reply = await chat(selected);
			expect(reply.status).toBe(200);
			expect(await reply.json()).toMatchObject({
				response: { output_text: "Scene plan" },
			});
			expect(requests[0]).toMatchObject({
				model: selected,
				instructions: "Prepare a scene plan from the references.",
				store: false,
			});
			expect(requests[0]).not.toHaveProperty("tools");
			expect(requests).toHaveLength(1);
			const stale = await chat("gpt-stale-desktop-preference");
			expect(stale.status).toBe(502);
			expect(requests).toHaveLength(1);
			expect((await chat()).status).toBe(200);
			expect(requests[1]?.model).toBe("test/vision-first");
			fail = true;
			expect((await chat(selected)).status).toBe(502);
			expect(requests).toHaveLength(3);
			disconnectHostedProvider();
			expect((await chat(selected)).status).toBe(401);
			expect(requests).toHaveLength(3);
		});
	} finally {
		await accountScope.run(account, () => disconnectHostedProvider());
		globalThis.fetch = previous.fetch;
		for (const [name, value] of [
			["OPENCUT_ACCOUNTS_DIR", previous.root],
			["OPENCUT_LEGITATE_HOSTED", previous.hosted],
			["OPENCUT_PUBLIC_ORIGIN", previous.origin],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(directory, { recursive: true, force: true });
	}
});
