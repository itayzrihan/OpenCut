import { isDeepStrictEqual } from "node:util";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, {
	LlmAdapter,
	ToolCallId,
	createUserMessage,
	type GenerateOptions,
	type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjections from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import * as NativeExecutor from "@deepseek-ai/dsh-tool-executor-native";
import {
	canonicalApplyResult,
	canonicalProviderResult,
	type HarnessCall,
	type HarnessPhase,
} from "../harness-protocol";

export interface EditorHarnessBridge {
	/** Browser IO proxy. Rust prepares context and validates every action. */
	call(input: {
		operation: HarnessCall["operation"];
		round: number;
	}): Promise<unknown>;
}

/** DSH owns model/tool scheduling. Native opencut_editor calls dispatch back to
 * Rust, which remains the context source, live feature registry, project
 * authority and sole completion gate. */
export async function runDeepseekEditorHarness({
	id,
	model,
	bridge,
	signal,
}: {
	id: string;
	model: string;
	bridge: EditorHarnessBridge;
	signal: AbortSignal;
}): Promise<HarnessPhase> {
	const ctx = new Context();
	let phase: HarnessPhase = "ready";
	let round = 0;
	let journalBytes = 0;
	let pending: { round: number; tool: string; args: unknown } | undefined;
	let failure: unknown;
	let fatal: unknown;
	const terminal = () => ["completed", "failed", "paused"].includes(phase);
	class CanonicalProvider extends LlmAdapter {
		async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
			signal.throwIfAborted();
			options.signal?.throwIfAborted();
			if (fatal) throw fatal;
			if (terminal()) {
				yield { type: "finish", reason: { kind: "stop" } };
				return;
			}
			if (pending !== undefined)
				throw new Error("Reconcile the canonical response first");
			if (++round > 2000)
				throw new Error("Harness round limit reached; resume the editing run");
			// The existing provider transport owns authentication, streaming and
			// safe retries. Never install a DSH credential/provider plugin.
			const { response } = canonicalProviderResult.parse(
				await bridge.call({ operation: "provider", round }),
			);
			signal.throwIfAborted();
			// Native calls retain the model's identity and arguments. A malformed,
			// text-only or multi-call envelope still needs Rust's feedback path;
			// dispatch that whole response once rather than replaying its actions.
			const calls = Array.isArray(response.output)
				? response.output.filter(
						(item): item is Record<string, unknown> =>
							!!item &&
							typeof item === "object" &&
							item.type === "function_call",
					)
				: [];
			let tool = "opencut_dispatch",
				argumentsValue: unknown = { round },
				identity = `canonical-${round}`;
			if (
				calls.length === 1 &&
				calls[0].name === "opencut_editor" &&
				typeof calls[0].call_id === "string" &&
				typeof calls[0].arguments === "string"
			) {
				try {
					const parsed: unknown = JSON.parse(calls[0].arguments);
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						tool = "opencut_editor";
						argumentsValue = parsed;
						identity = calls[0].call_id;
					}
				} catch {
					/* Rust reports the invalid model action. */
				}
			}
			pending = { round, tool, args: argumentsValue };
			const callId = ToolCallId(identity);
			const args = JSON.stringify(argumentsValue);
			journalBytes += Buffer.byteLength(args);
			if (journalBytes > 32_000_000)
				throw new Error(
					"Harness journal budget reached; resume from the canonical checkpoint",
				);
			yield { type: "block-start", index: 0, blockType: "tool-call" };
			yield {
				type: "tool-call-delta",
				index: 0,
				id: callId,
				name: tool,
				argumentsDelta: args,
			};
			yield {
				type: "block-end",
				index: 0,
				block: {
					type: "tool-call",
					id: callId,
					name: tool,
					arguments: args,
				},
			};
			yield { type: "finish", reason: { kind: "tool-calls" } };
		}
	}
	try {
		// Deliberate positive composition: no CLI profile, plugin loader,
		// filesystem, terminal, browser, computer-use, MCP, or code executor.
		await ctx.plugin(LlmRuntime);
		await ctx.plugin(SessionStore);
		await ctx.plugin(SessionProjections);
		await ctx.plugin(SystemPrompt, {
			personaPrefix: "OpenCut canonical editor bridge",
		});
		await ctx.plugin(Tools);
		await ctx.plugin(NativeExecutor);
		await ctx.plugin(AgentRegistry);
		await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
		ctx.llm.registerAdapter(["opencut-codex"], new CanonicalProvider());
		for (const tool of ["opencut_editor", "opencut_dispatch"])
			ctx.tools.register({
				name: tool,
				description:
					"Apply one completed response through the scoped canonical editor runtime",
				// Never sent to Codex: Rust supplies the exact live action schema.
				parameters: { type: "object", additionalProperties: true },
				output: {
					schema: { type: "string" },
					render: (_args, value) => [{ type: "text", text: String(value) }],
				},
				async execute(args, exec) {
					try {
						signal.throwIfAborted();
						exec.signal.throwIfAborted();
						if (
							!pending ||
							pending.tool !== tool ||
							!isDeepStrictEqual(args, pending.args)
						)
							throw new Error("Stale or substituted canonical dispatch");
						const current = pending.round;
						pending = undefined; // Never replay a callback after a lost reply.
						phase = canonicalApplyResult.parse(
							await bridge.call({ operation: "apply", round: current }),
						).phase;
						return phase;
					} catch (error) {
						fatal = error;
						throw error;
					}
				},
			});
		signal.throwIfAborted();
		const handle = await ctx.agents.create({
			sessionId: SessionId(id),
			agentOptions: { provider: "opencut-codex", model },
		});
		const agent = handle.agent;
		const abort = () => agent.cancel({ kind: "user" });
		signal.addEventListener("abort", abort, { once: true });
		try {
			await new Promise<void>((resolve) => {
				ctx.on("agent/error", ({ error }) => {
					failure = error;
				});
				ctx.on("agent/status", ({ agent: subject, status }) => {
					if (subject === agent && status === "idle") resolve();
				});
				if (signal.aborted) {
					resolve();
					return;
				}
				agent.followup(
					createUserMessage({
						content: [
							{ type: "text", text: "Continue the canonical editing run" },
						],
						source: { kind: "user" },
					}),
				);
			});
			signal.throwIfAborted();
			if (fatal) throw fatal;
			if (failure) throw failure;
			if (!terminal())
				throw new Error(
					"Harness stopped before the canonical run reached a terminal phase",
				);
			return phase;
		} finally {
			signal.removeEventListener("abort", abort);
			await handle.dispose();
		}
	} finally {
		await ctx.fiber.dispose();
	}
}
