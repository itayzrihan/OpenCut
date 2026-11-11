import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CodexProvider,
	ClaudeProvider,
	decodeGeneratedImage,
} from "./native-providers";
import { generateJournaledImage } from "./image-journal";
import { companionHandler } from "./handler";
import {
	planningImages,
	planningPrompt,
	proposalResponse,
	type ImageRequest,
} from "./protocol";
const png = Buffer.concat([
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	Buffer.alloc(32),
]).toString("base64");
async function fixture({ hold = false, legacy = false, imageFile = false } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pocut-native-test-"));
	const executable = join(root, "mock-provider.cjs");
	await writeFile(
		executable,
		`#!/usr/bin/env node
const fs=require('fs'),readline=require('readline'),path=require('path');const log=path.join(${JSON.stringify(root)},'calls.jsonl');const say=v=>process.stdout.write(JSON.stringify(v)+'\\n');
fs.appendFileSync(log,JSON.stringify({args:process.argv.slice(2),codexHome:process.env.CODEX_HOME,claudeHome:process.env.CLAUDE_CONFIG_DIR,apiKey:!!process.env.OPENAI_API_KEY})+'\\n');
if(process.argv.includes('--version')){console.log('Claude Code 2.1.248');process.exit();}
if(process.argv[2]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'fixture@example.test'}));process.exit();}
if(process.argv.includes('-p')){let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{fs.appendFileSync(log,JSON.stringify({input:JSON.parse(input)})+'\\n');console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{text:'Claude plan',calls:[]}}));});}
else readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\\n');if(!m.method)return;let result={};switch(m.method){case'account/read':result={account:{type:'chatgpt',email:'fixture@example.test'}};break;case'modelProvider/capabilities/read':result={imageGeneration:true};break;case'model/list':result={data:[{id:'fixture',model:'fixture-model',displayName:'Fixture',supportedReasoningEfforts:[]}]};break;case'account/login/start':result={authUrl:'https://auth.openai.com/authorize?fixture=1'};break;case'thread/start':result={thread:{id:'thread-fixture'},...(!${JSON.stringify(legacy)}&&{activePermissionProfile:{id:m.params.permissions}})};break;case'turn/start':if(!${JSON.stringify(legacy)}&&m.params.sandboxPolicy?.access){say({id:m.id,error:{code:-32600,message:'readOnly.access is no longer supported'}});return;}result={turn:{id:'turn-fixture'}};break;}if(m.id!==undefined)say({id:m.id,result});if(m.method==='turn/start'&&!${JSON.stringify(hold)}){say({id:900,method:'item/commandExecution/requestApproval',params:{}});say({method:'item/completed',params:{threadId:'thread-fixture',item:m.params.outputSchema?{type:'agentMessage',text:JSON.stringify({text:'Proposed edit',calls:[]})}:{type:'imageGeneration',status:'completed',...(${JSON.stringify(imageFile)}?{savedPath:(()=>{const file=path.join(process.env.CODEX_HOME,'generated.png');fs.writeFileSync(file,Buffer.from(${JSON.stringify(png)},'base64'));return file})()}:{result:${JSON.stringify(png)}})}}});say({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});}});
`,
		{ mode: 0o700 },
	);
	return {
		root,
		executable,
		log: async () =>
			(await readFile(join(root, "calls.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
	};
}

test("native Codex uses isolated official protocol, structured proposals and native image bytes without machine tools", async () => {
	const f = await fixture();
	const provider = new CodexProvider({
		root: f.root,
		executable: f.executable,
	});
	try {
		const statuses = await Promise.all([provider.status(), provider.status()]);
		expect(statuses.every((s) => s.sharing && s.imageGenerationSupported)).toBe(
			true,
		);
		const result = await provider.respond({
			request: {
				model: "fixture-model",
				input: [{ role: "user", content: "Plan a cut" }],
				tools: [],
			},
			signal: new AbortController().signal,
		});
		expect(result).toMatchObject({
			status: "completed",
			output_text: "Proposed edit",
		});
		const image = await provider.image({
			request: {
				projectId: "p",
				operationId: "one",
				prompt: "A lighthouse",
				references: [],
				confirmed: true,
			},
			signal: new AbortController().signal,
		});
		expect(image.mimeType).toBe("image/png");
		const calls = await f.log();
		expect(calls.filter((c) => c.method === "initialize")).toHaveLength(1);
		expect(calls.find((c) => c.args)?.args).toContain("--disable");
		expect(calls.find((c) => c.args)?.codexHome).toBe(join(f.root, "codex"));
		expect(calls.find((c) => c.id === 900)?.error).toBeDefined();
		const turns = calls.filter((c) => c.method === "turn/start");
		expect(turns).toHaveLength(2);
		expect(turns[0].params.sandboxPolicy).toBeUndefined();
		const imageThread = calls.filter((c) => c.method === "thread/start")[1].params;
		expect(imageThread.baseInstructions).toContain("image_gen.imagegen");
		expect(imageThread.baseInstructions).toContain("The exec tool is unavailable");
		expect(imageThread.config.features).toEqual({
			image_generation: true,
			code_mode: { enabled: false, direct_only_tool_namespaces: ["image_gen"] },
		});
		const thread = calls.find((c) => c.method === "thread/start").params;
		expect(thread.config.features).toEqual({ image_generation: false });
		expect(thread.permissions).toBe("pocut");
		expect(thread.config.permissions.pocut).toEqual({
			filesystem: { ":minimal": "read", [thread.cwd]: "read" },
			network: { enabled: false },
		});
		expect(turns[0].params.outputSchema.properties.calls.maxItems).toBe(0);
	} finally {
		provider.close();
		await rm(f.root, { recursive: true, force: true });
	}
});

test("Codex imports the savedPath image result from its private profile", async () => {
	const f = await fixture({ imageFile: true });
	const provider = new CodexProvider({ root: f.root, executable: f.executable });
	try {
		const image = await provider.image({ request: { projectId: "p", operationId: "file", prompt: "A lighthouse", references: [], confirmed: true }, signal: new AbortController().signal });
		expect(image).toEqual({ base64: png, mimeType: "image/png" });
	} finally {
		provider.close();
		await rm(f.root, { recursive: true, force: true });
	}
});

test("legacy Codex turns still use restricted read-only access", async () => {
	const f = await fixture({ legacy: true });
	const provider = new CodexProvider({
		root: f.root,
		executable: f.executable,
	});
	try {
		await provider.respond({
			request: {
				model: "fixture-model",
				input: [{ role: "user", content: "Plan a cut" }],
				tools: [],
			},
			signal: new AbortController().signal,
		});
		const calls = await f.log();
		const turn = calls.find((call) => call.method === "turn/start").params;
		const thread = calls.find((call) => call.method === "thread/start").params;
		expect(turn.sandboxPolicy).toEqual({
			type: "readOnly",
			access: {
				type: "restricted",
				includePlatformDefaults: true,
				readableRoots: [thread.cwd],
			},
		});
	} finally {
		provider.close();
		await rm(f.root, { recursive: true, force: true });
	}
});

test("Claude invokes the unmodified CLI in restricted safe mode with inline vision and no MCP tools", async () => {
	const f = await fixture();
	const provider = new ClaudeProvider({
		root: f.root,
		executable: f.executable,
	});
	try {
		const result = await provider.respond({
			request: {
				model: "sonnet",
				input: [
					{
						role: "user",
						content: [
							{
								type: "input_image",
								image_url: `data:image/png;base64,${png}`,
							},
						],
					},
				],
				tools: [],
			},
			signal: new AbortController().signal,
		});
		expect(result.output_text).toBe("Claude plan");
		const calls = await f.log();
		const args = calls.find((c) => c.args?.includes("-p")).args;
		expect(args).toContain("--safe-mode");
		expect(args).toContain("--restricted");
		expect(args).not.toContain("--bare");
		expect(args).toContain("--strict-mcp-config");
		const input = calls.find((c) => c.input).input;
		expect(input.message.content[1].source.media_type).toBe("image/png");
		expect(input.message.content[0].text).not.toContain(png);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test("image journal is stable, rejects changed payload and never repeats uncertain provider spend", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocut-journal-test-"));
	let called = 0;
	const provider = {
		image: async () => {
			called++;
			return decodeGeneratedImage(png);
		},
	} as unknown as CodexProvider;
	const request: ImageRequest = {
		projectId: "p",
		operationId: "one",
		prompt: "Moon",
		references: [],
		confirmed: true,
	};
	const signal = new AbortController().signal;
	try {
		const first = await generateJournaledImage({
			root,
			provider,
			request,
			signal,
		});
		expect(
			await generateJournaledImage({ root, provider, request, signal }),
		).toEqual(first);
		expect(called).toBe(1);
		await expect(
			generateJournaledImage({
				root,
				provider,
				request: { ...request, prompt: "Sun" },
				signal,
			}),
		).rejects.toThrow("different content");
		const failing = {
			image: async () => {
				called++;
				throw new Error("connection lost after submit");
			},
		} as unknown as CodexProvider;
		await expect(
			generateJournaledImage({
				root,
				provider: failing,
				request: { ...request, operationId: "uncertain" },
				signal,
			}),
		).rejects.toThrow("connection lost");
		await expect(
			generateJournaledImage({
				root,
				provider: failing,
				request: { ...request, operationId: "uncertain" },
				signal,
			}),
		).rejects.toThrow("uncertain");
		expect(called).toBe(2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("unavailable or unconfirmed images never reach the native provider; model calls stay in live registry", async () => {
	let calls = 0;
	const provider = {
		image: async () => {
			calls++;
			return decodeGeneratedImage(png);
		},
	} as unknown as CodexProvider;
	const handler = companionHandler({
		providers: { codex: provider, claude: provider },
		imageRoot: "/unused",
	});
	const response = await handler({
		path: "/api/ai/local-image",
		method: "POST",
		provider: "codex",
		signal: new AbortController().signal,
		body: new TextEncoder().encode(
			JSON.stringify({
				projectId: "p",
				operationId: "one",
				prompt: "Sun",
				confirmed: false,
			}),
		),
	});
	expect(response.status).toBe(400);
	expect(calls).toBe(0);
	expect(() =>
		proposalResponse({
			raw: { text: "", calls: [{ name: "shell", arguments: "{}" }] },
			request: { model: "x", input: [], tools: [] },
		}),
	).toThrow("unavailable");
	const request = {
		model: "x",
		input: [{ image_url: `data:image/png;base64,${png}` }],
		tools: [],
	};
	expect(planningImages(request)).toHaveLength(1);
	expect(planningPrompt(request)).not.toContain(png);
});

test("cancelling a native turn terminates it without a second provider request", async () => {
	const f = await fixture({ hold: true });
	const closedChildren: Promise<void>[] = [];
	const provider = new CodexProvider({
		root: f.root,
		executable: f.executable,
		spawnChild(file, args, options) {
			const child = spawn(file, args, options);
			closedChildren.push(new Promise((resolve) => child.once("close", () => resolve())));
			return child;
		},
	});
	const controller = new AbortController();
	try {
		const work = provider.respond({
			request: {
				model: "fixture-model",
				input: [{ role: "user", content: "wait" }],
				tools: [],
			},
			signal: controller.signal,
		});
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline) {
			const log = await f.log().catch(() => []);
			if (log.some((c) => c.method === "turn/start")) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		controller.abort();
		await expect(work).rejects.toThrow("cancelled");
		expect(
			(await f.log()).filter((c) => c.method === "turn/start"),
		).toHaveLength(1);
		expect((await provider.status()).installed).toBe(true);
	} finally {
		provider.close();
		await Promise.all(closedChildren);
		await rm(f.root, { recursive: true, force: true });
	}
});
