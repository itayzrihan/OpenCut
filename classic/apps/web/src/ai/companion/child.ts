import { z } from "zod";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface RpcMessage {
	method?: string;
	params?: Record<string, unknown>;
	error?: unknown;
}
const rpcSchema = z
	.object({
		id: z.union([z.number(), z.string()]).optional(),
		method: z.string().optional(),
		params: z.record(z.string(), z.unknown()).optional(),
		result: z.unknown().optional(),
		error: z.unknown().optional(),
	})
	.passthrough();
export type SpawnChild = typeof spawn;
/** Fixed executable/arguments chosen by the local companion, never by an HTTP caller. */
export function runChild({
	executable,
	args,
	cwd,
	env,
	input,
	signal,
	spawnChild = spawn,
	maximumBytes = 4_000_000,
	timeoutMs = 180_000,
}: {
	executable: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	input?: string;
	signal: AbortSignal;
	spawnChild?: SpawnChild;
	maximumBytes?: number;
	timeoutMs?: number;
}): Promise<string> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawnChild(executable, args, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "",
			settled = false;
		const stop = () => {
			child.kill("SIGTERM");
			setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			}, 1000).unref();
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (error) {
				stop();
				reject(error);
			} else resolve(stdout);
		};
		const abort = () => finish(new Error("Local provider request cancelled"));
		const timer = setTimeout(
			() =>
				finish(new Error("Local provider timed out; no request was retried")),
			timeoutMs,
		);
		timer.unref();
		signal.addEventListener("abort", abort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (Buffer.byteLength(stdout) > maximumBytes)
				finish(new Error("Local provider output exceeded its limit"));
		});
		child.stderr?.on("data", () => {});
		child.once("error", () =>
			finish(new Error("The provider CLI is not installed or could not start")),
		);
		child.once("close", (code) =>
			finish(
				code === 0
					? undefined
					: new Error(
							`Local provider exited without completing (${code ?? "signal"}). Check its sign-in and usage limits.`,
						),
			),
		);
		child.stdin?.on("error", () =>
			finish(new Error("The local provider stopped accepting input")),
		);
		if (signal.aborted) abort();
		child.stdin?.end(input ?? "");
	});
}

export class CodexRpc {
	private child: ChildProcessWithoutNullStreams | null = null;
	private sequence = 0;
	private starting: Promise<void> | null = null;
	private buffer = "";
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private listeners = new Set<(message: RpcMessage) => void>();
	constructor(
		private readonly options: {
			executable: string;
			home: string;
			cwd: string;
			spawnChild?: SpawnChild;
		},
	) {}
	async start() {
		if (this.starting) return this.starting;
		if (this.child) return;
		this.starting = this.initialize();
		try {
			await this.starting;
		} finally {
			this.starting = null;
		}
	}
	private async initialize() {
		this.buffer = "";
		const disabled = [
			"shell_tool",
			"apps",
			"plugins",
			"remote_plugin",
			"hooks",
			"multi_agent",
			"browser_use",
			"browser_use_external",
			"computer_use",
			"in_app_browser",
			"view_image",
			"memories",
			"shell_snapshot",
			"code_mode",
			"code_mode_host",
			"skill_mcp_dependency_install",
			"skill_search",
			"goals",
		];
		const args = [
			"app-server",
			"--listen",
			"stdio://",
			"-c",
			'approval_policy="never"',
			"-c",
			'sandbox_mode="read-only"',
			"-c",
			'web_search="disabled"',
			"-c",
			"mcp_servers={}",
			...disabled.flatMap((name) => ["--disable", name]),
		];
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CODEX_HOME: this.options.home,
		};
		delete env.OPENAI_API_KEY;
		delete env.OPENAI_BASE_URL;
		delete env.OPENAI_ACCESS_TOKEN;
		this.child = (this.options.spawnChild ?? spawn)(
			this.options.executable,
			args,
			{
				cwd: this.options.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
			},
		);
		const activeChild = this.child;
		this.child.stdout.on("data", (chunk: Buffer) => {
			if (this.child !== activeChild) return;
			this.buffer += chunk.toString();
			if (Buffer.byteLength(this.buffer) > 24_000_000) {
				this.close(new Error("Codex output exceeded its limit"));
				return;
			}
			let newline;
			while ((newline = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				if (!line.trim()) continue;
				try {
					const msg = rpcSchema.parse(JSON.parse(line));
					if (msg.method && msg.id !== undefined) {
						this.send({
							id: msg.id,
							error: {
								code: -32601,
								message:
									"Local machine tools and permission escalation are unavailable in POCUT",
							},
						});
						continue;
					}
					if (msg.id !== undefined) {
						const call = this.pending.get(Number(msg.id));
						if (call) {
							this.pending.delete(Number(msg.id));
							if (msg.error)
								call.reject(
									new Error(
										"Codex rejected the request; check CLI compatibility and account access",
									),
								);
							else call.resolve(msg.result);
						}
					} else for (const listener of this.listeners) listener(msg);
				} catch {
					this.close(new Error("Invalid Codex protocol output"));
				}
			}
		});
		this.child.stderr.on("data", () => {});
		this.child.stdin.on("error", () => {
			if (this.child === activeChild)
				this.close(new Error("Codex stopped accepting input"));
		});
		this.child.once("error", () => {
			if (this.child === activeChild)
				this.close(new Error("Install Codex CLI before connecting"));
		});
		this.child.once("exit", () => {
			if (this.child === activeChild)
				this.close(new Error("Codex stopped before completing"));
		});
		await this.call({
			method: "initialize",
			params: {
				clientInfo: {
					name: "pocut_local_companion",
					title: "POCUT Local Companion",
					version: "1",
				},
				capabilities: { experimentalApi: true },
			},
		});
		this.send({ method: "initialized", params: {} });
	}
	private send(message: unknown) {
		if (!this.child) throw new Error("Codex is not running");
		this.child.stdin.write(JSON.stringify(message) + "\n");
	}
	call({
		method,
		params,
	}: {
		method: string;
		params: unknown;
	}): Promise<unknown> {
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("Codex request timed out"));
			}, 30_000);
			timer.unref();
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				this.send({ id, method, params });
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error);
			}
		});
	}
	listen(listener: (message: RpcMessage) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	close(error = new Error("Codex connection closed")) {
		const child = this.child;
		this.child = null;
		child?.kill("SIGTERM");
		if (child)
			setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			}, 1000).unref();
		for (const call of this.pending.values()) call.reject(error);
		this.pending.clear();
		for (const listener of this.listeners)
			listener({ method: "pocut/closed", error });
		this.listeners.clear();
	}
}
