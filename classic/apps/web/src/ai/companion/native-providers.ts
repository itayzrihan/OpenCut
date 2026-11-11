import { z } from "zod";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { CodexRpc, runChild, type SpawnChild } from "./child";
import {
	planningPrompt,
	planningImages,
	proposalResponse,
	proposalSchema,
	type LocalRequest,
	type LocalStatus,
	type LocalModel,
	type ImageRequest,
} from "./protocol";

export interface NativeProvider {
	status(): Promise<LocalStatus>;
	models(signal: AbortSignal): Promise<LocalModel[]>;
	signIn(): Promise<{ authorizationUrl: string; expiresAt: number }>;
	respond(input: {
		request: LocalRequest;
		signal: AbortSignal;
	}): Promise<unknown>;
	image(input: {
		request: ImageRequest;
		signal: AbortSignal;
	}): Promise<{ base64: string; mimeType: string }>;
	disconnect(): Promise<void>;
	close(): void;
}
const denied = () => {
	throw new Error("Image generation is unavailable with this provider");
};
export function decodeGeneratedImage(value: string) {
	const data = value.replace(/^data:image\/(png|jpeg|webp);base64,/, "");
	if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length > 24_000_000)
		throw new Error("Invalid generated image");
	const bytes = Buffer.from(data, "base64");
	const mimeType = bytes
		.subarray(0, 8)
		.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
		? "image/png"
		: bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
			? "image/jpeg"
			: bytes.toString("ascii", 0, 4) === "RIFF" &&
				  bytes.toString("ascii", 8, 12) === "WEBP"
				? "image/webp"
				: null;
	if (!mimeType || bytes.length > 16_000_000 || bytes.length < 16)
		throw new Error("Codex did not return a supported generated image");
	return { base64: bytes.toString("base64"), mimeType };
}
export class CodexProvider implements NativeProvider {
	private rpc: CodexRpc;
	private connecting = false;
	private busy = false;
	constructor(
		private readonly options: {
			root: string;
			executable?: string;
			spawnChild?: SpawnChild;
		},
	) {
		this.rpc = new CodexRpc({
			home: join(options.root, "codex"),
			cwd: join(options.root, "workspace"),
			executable: options.executable ?? "codex",
			spawnChild: options.spawnChild,
		});
	}
	private async ready() {
		await mkdir(join(this.options.root, "codex"), {
			recursive: true,
			mode: 0o700,
		});
		await mkdir(join(this.options.root, "workspace"), {
			recursive: true,
			mode: 0o700,
		});
		await this.rpc.start();
	}
	async status(): Promise<LocalStatus> {
		const base = {
			provider: "local-codex" as const,
			usageUrl: "https://chatgpt.com/settings/usage",
			identity: null,
			connecting: this.connecting,
			imageGenerationSupported: false,
		};
		try {
			await this.ready();
			const value = z
				.object({
					account: z
						.object({ type: z.string(), email: z.string().optional() })
						.nullable(),
				})
				.parse(
					await this.rpc.call({
						method: "account/read",
						params: { refreshToken: false },
					}),
				);
			let images = false;
			try {
				images = z.object({ imageGeneration: z.boolean() }).parse(
					await this.rpc.call({
						method: "modelProvider/capabilities/read",
						params: {},
					}),
				).imageGeneration;
			} catch {
				/* Older CLIs cannot claim this capability. */
			}
			const connected = value.account?.type === "chatgpt";
			return {
				...base,
				installed: true,
				connected,
				sharing: connected,
				authenticationRequired: !connected,
				identity: connected
					? {
							name: "Codex",
							...(typeof value.account?.email === "string"
								? { email: value.account?.email }
								: {}),
						}
					: null,
				imageGenerationSupported: connected && images,
				error:
					value.account && !connected
						? "Sign in to the POCUT Codex profile with your ChatGPT account."
						: null,
			};
		} catch {
			return {
				...base,
				installed: false,
				connected: false,
				sharing: false,
				authenticationRequired: true,
				error: "Install or update Codex CLI, then reconnect this device.",
			};
		}
	}
	async models(signal: AbortSignal): Promise<LocalModel[]> {
		signal.throwIfAborted();
		await this.ready();
		if (!(await this.status()).sharing) return [];
		const value = z
			.object({
				data: z.array(
					z.object({
						id: z.string(),
						model: z.string().optional(),
						hidden: z.boolean().optional(),
						displayName: z.string().optional(),
						supportedReasoningEfforts: z
							.array(z.object({ reasoningEffort: z.string() }))
							.optional(),
					}),
				),
			})
			.parse(
				await this.rpc.call({
					method: "model/list",
					params: { limit: 100, includeHidden: false },
				}),
			);
		signal.throwIfAborted();
		return value.data
			.filter((v) => !v.hidden)
			.map((v) => ({
				id: v.model ?? v.id,
				name: v.displayName ?? v.model ?? v.id,
				reasoningEfforts: (v.supportedReasoningEfforts ?? []).map(
					(e) => e.reasoningEffort,
				),
			}));
	}
	async signIn() {
		await this.ready();
		const result = z
			.object({
				authUrl: z.string().optional(),
				authorizationUrl: z.string().optional(),
			})
			.parse(
				await this.rpc.call({
					method: "account/login/start",
					params: { type: "chatgpt" },
				}),
			);
		const url = result.authUrl ?? result.authorizationUrl;
		if (
			typeof url !== "string" ||
			new URL(url).origin !== "https://auth.openai.com"
		)
			throw new Error("Codex did not provide an official sign-in URL");
		this.connecting = true;
		const off = this.rpc.listen((msg) => {
			if (msg.method === "account/login/completed") {
				this.connecting = false;
				off();
			}
		});
		return { authorizationUrl: url, expiresAt: Date.now() + 5 * 60_000 };
	}
	private async turn({
		request,
		input,
		image,
		signal,
	}: {
		request: LocalRequest;
		input: Array<Record<string, unknown>>;
		image: boolean;
		signal: AbortSignal;
	}) {
		signal.throwIfAborted();
		if (this.busy)
			throw new Error(
				"The local provider is busy; wait for the active request",
			);
		this.busy = true;
		let workspace = "";
		try {
			await this.ready();
			if (!(await this.status()).sharing)
				throw new Error("Continue with ChatGPT before using Codex");
			const models = await this.models(signal);
			if (!models.some((m) => m.id === request.model))
				throw new Error("Choose a model available in this Codex connection");
			workspace = await mkdtemp(join(this.options.root, "workspace", "turn-"));
			const started = Date.now();
			const thread = await this.rpc.call({
				method: "thread/start",
				params: {
					model: request.model,
					cwd: workspace,
					ephemeral: true,
					permissions: "pocut",
					approvalPolicy: "never",
					allowProviderModelFallback: false,
					selectedCapabilityRoots: [],
					config: {
						features: { image_generation: image },
						web_search: "disabled",
						mcp_servers: {},
						permissions: {
							pocut: {
								filesystem: { ":minimal": "read", [workspace]: "read" },
								network: { enabled: false },
							},
						},
					},
					baseInstructions: image
						? "Use the built-in image generation tool to generate the requested image. Return its native image result. Never run commands, open local files, install software, call MCP tools, or use a browser."
						: "You only produce structured POCUT editing proposals. Never execute tools or access the local filesystem or network. The browser validates and executes proposed actions.",
				},
			});
			const startedThread = z
				.object({
					thread: z.object({ id: z.string() }),
					activePermissionProfile: z.object({ id: z.string() }).nullish(),
				})
				.parse(thread);
			const id = startedThread.thread.id;
			const usesNamedPermissions =
				startedThread.activePermissionProfile?.id === "pocut";
			const items: unknown[] = [];

			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const done = (error?: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					off();
					signal.removeEventListener("abort", abort);
					if (error) reject(error);
					else resolve();
				};
				const abort = () => {
					done(new Error("Local provider request cancelled"));
					this.rpc.close();
				};
				const timeout = setTimeout(
					() => {
						done(new Error("Local generation timed out; no retry was sent"));
						this.rpc.close();
					},
					image ? 300_000 : 180_000,
				);
				timeout.unref();
				const off = this.rpc.listen((msg) => {
					if (msg.method === "pocut/closed")
						return done(new Error("Codex disconnected"));
					if (msg.params?.threadId !== id) return;
					if (msg.method === "item/completed") items.push(msg.params.item);
					if (msg.method === "turn/completed")
						done(
							z.object({ status: z.string() }).parse(msg.params.turn).status ===
								"completed"
								? undefined
								: new Error(
										"Codex did not complete the request. Check sign-in and usage limits.",
									),
						);
				});
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) {
					abort();
					return;
				}
				void this.rpc
					.call({
						method: "turn/start",
						params: {
							threadId: id,
							input,
							model: request.model,
							approvalPolicy: "never",
							// New CLI versions inherit the restricted thread profile. Older
							// versions omit activePermissionProfile and use legacy access.
							...(!usesNamedPermissions
								? {
										sandboxPolicy: {
											type: "readOnly",
											access: {
												type: "restricted",
												includePlatformDefaults: true,
												readableRoots: [workspace],
											},
										},
									}
								: {}),
							...(image ? {} : { outputSchema: proposalSchema(request) }),
						},
					})
					.then(
						() => {},
						(cause: unknown) =>
							done(
								cause instanceof Error
									? cause
									: new Error("Codex could not start this request"),
							),
					);
			});
			if (image) {
				const generated = items
					.map((item) =>
						z
							.object({
								type: z.literal("imageGeneration"),
								status: z.literal("completed"),
								failure: z.unknown().optional(),
								result: z.string().nullable().optional(),
								savedPath: z.string().nullable().optional(),
							})
							.safeParse(item),
					)
					.find((item) => item.success && !item.data.failure)?.data;
				if (!generated && items.some((item) => z.object({
					type: z.literal("imageGeneration"), failure: z.object({ type: z.literal("usageLimitExceeded") }),
				}).safeParse(item).success)) {
					throw new Error("Your Codex image generation limit was reached. Check ChatGPT usage before trying again.");
				}
				if (!generated)
					throw new Error(
						"Codex completed without a generated image. No image was imported.",
					);
				if (typeof generated.result === "string" && generated.result)
					return decodeGeneratedImage(generated.result);
				if (typeof generated.savedPath !== "string")
					throw new Error(
						"This Codex version did not expose downloadable image bytes. Update the CLI.",
					);
				const path = await realpath(generated.savedPath),
					home = await realpath(this.options.root);
				const insideProfile = relative(home, path);
				if (!insideProfile || isAbsolute(insideProfile) || insideProfile === ".." || insideProfile.startsWith(`..${sep}`))
					throw new Error(
						"Generated output was outside the private POCUT profile",
					);
				const info = await stat(path);
				if (
					!info.isFile() ||
					info.size > 16_000_000 ||
					info.mtimeMs < started - 1000
				)
					throw new Error("Invalid generated output file");
				return decodeGeneratedImage((await readFile(path)).toString("base64"));
			}
			const message = items
				.map((item) =>
					z
						.object({ type: z.literal("agentMessage"), text: z.string() })
						.safeParse(item),
				)
				.filter((item) => item.success)
				.at(-1)?.data;
			if (typeof message?.text !== "string")
				throw new Error("Codex did not return a completed proposal");
			return proposalResponse({ raw: JSON.parse(message.text), request });
		} finally {
			this.busy = false;
			if (workspace) await rm(workspace, { recursive: true, force: true });
		}
	}
	respond({ request, signal }: { request: LocalRequest; signal: AbortSignal }) {
		return this.turn({
			request,
			input: [
				{ type: "text", text: planningPrompt(request) },
				...planningImages(request).map((url) => ({ type: "image", url })),
			],
			image: false,
			signal,
		});
	}
	async image({
		request,
		signal,
	}: {
		request: ImageRequest;
		signal: AbortSignal;
	}) {
		const status = await this.status();
		if (!status.connected) throw new Error(status.error ?? "Connect Codex with your ChatGPT subscription first.");
		if (!status.imageGenerationSupported) throw new Error("This Codex connection does not advertise native image generation. Update the official Codex CLI, restart the Companion, and use Check Connection.");
		const models = await this.models(signal);
		const model = request.model ?? models[0]?.id;
		if (!model) throw new Error("No Codex model is available");
		const result = await this.turn({
			request: { model, input: [], tools: [] },
			input: [
				{
					type: "text",
					text:
						request.prompt +
						"\nReturn a PNG image using native image generation.",
				},
				...request.references.map((url) => ({ type: "image", url })),
			],
			image: true,
			signal,
		});
		return z.object({ base64: z.string(), mimeType: z.string() }).parse(result);
	}
	async disconnect() {
		await this.ready();
		await this.rpc.call({ method: "account/logout", params: {} });
		this.connecting = false;
		this.close();
	}
	close() {
		this.rpc.close();
	}
}

export class ClaudeProvider implements NativeProvider {
	constructor(
		private readonly options: {
			root: string;
			executable?: string;
			spawnChild?: SpawnChild;
		},
	) {}
	private async run({
		args,
		signal,
		input,
	}: {
		args: string[];
		signal: AbortSignal;
		input?: string;
	}) {
		await mkdir(this.options.root, { recursive: true, mode: 0o700 });
		await mkdir(join(this.options.root, "workspace"), {
			recursive: true,
			mode: 0o700,
		});
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_CONFIG_DIR: join(this.options.root, "claude"),
		};
		for (const name of [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"CLAUDE_CODE_USE_BEDROCK",
			"CLAUDE_CODE_USE_VERTEX",
			"CLAUDE_CODE_USE_FOUNDRY",
		])
			delete env[name];
		return runChild({
			executable: this.options.executable ?? "claude",
			args,
			cwd: join(this.options.root, "workspace"),
			env,
			input,
			signal,
			spawnChild: this.options.spawnChild,
		});
	}
	async status(): Promise<LocalStatus> {
		let installed = false;
		const base = {
			provider: "local-claude" as const,
			usageUrl: "https://claude.ai/settings/usage",
			connecting: false,
			imageGenerationSupported: false,
		};
		try {
			const signal = AbortSignal.timeout(10_000);
			await this.run({ args: ["--version"], signal });
			installed = true;
			const r = JSON.parse(
				await this.run({ args: ["auth", "status"], signal }),
			);
			const connected = r.loggedIn === true && r.authMethod === "claude.ai";
			return {
				...base,
				installed,
				connected,
				sharing: connected,
				authenticationRequired: !connected,
				identity: connected
					? {
							name: "Claude",
							...(typeof r.email === "string" ? { email: r.email } : {}),
						}
					: null,
				error: null,
			};
		} catch {
			return {
				...base,
				installed,
				connected: false,
				sharing: false,
				authenticationRequired: true,
				identity: null,
				error: installed
					? "Sign in with the unmodified Claude CLI in the POCUT companion profile."
					: "Install Claude Code CLI before connecting this device.",
			};
		}
	}
	async models(signal: AbortSignal): Promise<LocalModel[]> {
		signal.throwIfAborted();
		return (await this.status()).sharing
			? [
					{ id: "sonnet", name: "Claude Sonnet" },
					{ id: "opus", name: "Claude Opus" },
					{ id: "haiku", name: "Claude Haiku" },
				]
			: [];
	}
	async signIn(): Promise<{ authorizationUrl: string; expiresAt: number }> {
		throw new Error(
			"Run the companion with --login-claude in your terminal. Claude handles sign-in directly; POCUT never receives its credentials.",
		);
	}
	async respond({
		request,
		signal,
	}: {
		request: LocalRequest;
		signal: AbortSignal;
	}) {
		if (!(await this.status()).sharing)
			throw new Error("Sign in to Claude Code before using this connection");
		if (!["sonnet", "opus", "haiku"].includes(request.model))
			throw new Error("Choose a supported Claude model alias");
		const raw = await this.run({
			args: [
				"--restricted",
				"--safe-mode",
				"-p",
				"--output-format",
				"stream-json",
				"--verbose",
				"--input-format",
				"stream-json",
				"--tools",
				"",
				"--disallowedTools",
				"mcp__*",
				"--strict-mcp-config",
				"--mcp-config",
				'{"mcpServers":{}}',
				"--no-session-persistence",
				"--max-turns",
				"1",
				"--model",
				request.model,
				"--json-schema",
				JSON.stringify(proposalSchema(request)),
			],
			signal,
			input:
				JSON.stringify({
					type: "user",
					message: {
						role: "user",
						content: [
							{ type: "text", text: planningPrompt(request) },
							...planningImages(request).map((url) => {
								const match =
									/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(url)!;
								return {
									type: "image",
									source: {
										type: "base64",
										media_type: match[1],
										data: match[2],
									},
								};
							}),
						],
					},
				}) + "\n",
		});
		const messages = raw
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) =>
				z.object({ type: z.string() }).passthrough().parse(JSON.parse(line)),
			);
		const result = z
			.object({
				type: z.literal("result"),
				is_error: z.boolean().optional(),
				subtype: z.string(),
				structured_output: z.unknown(),
			})
			.parse(messages.filter((item) => item.type === "result").at(-1));
		if (result.is_error || result.subtype !== "success")
			throw new Error(
				"Claude did not complete the request. No retry was sent.",
			);
		return proposalResponse({
			raw: result.structured_output,
			request,
		});
	}
	async image() {
		return denied();
	}
	async disconnect() {
		await this.run({
			args: ["auth", "logout"],
			signal: AbortSignal.timeout(15_000),
		});
	}
	close() {}
}
