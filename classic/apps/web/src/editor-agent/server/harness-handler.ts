import { requireAccount } from "@/accounts/server";
import {
	harnessReply,
	harnessStart,
	type HarnessEvent,
} from "../harness-protocol";
import { HarnessChannel } from "./harness-channel";
import { runDeepseekEditorHarness } from "./deepseek-harness";

const host = globalThis as typeof globalThis & {
	__opencutHarnessChannels?: Map<string, HarnessChannel>;
};
const channels = (host.__opencutHarnessChannels ??= new Map());

async function readBody(request: Request): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) throw new Error("Missing harness request");
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let text = "",
		size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 4_000_000) {
				await reader.cancel();
				throw new Error("Harness request is too large");
			}
			text += decoder.decode(value, { stream: true });
		}
		return JSON.parse(text + decoder.decode());
	} finally {
		reader.releaseLock();
	}
}

export async function handleHarnessRequest(
	request: Request,
): Promise<Response> {
	const accountId = requireAccount().id;
	let value: unknown;
	try {
		value = await readBody(request);
	} catch {
		return Response.json({ error: "Invalid harness request" }, { status: 400 });
	}
	const reply = harnessReply.safeParse(value);
	if (reply.success) {
		const channel = channels.get(reply.data.runId);
		if (!channel)
			return Response.json(
				{ error: "Harness run is unavailable; resume from the editor" },
				{ status: 409 },
			);
		try {
			channel.reply({ ...reply.data, accountId });
			return Response.json({ accepted: true });
		} catch {
			return Response.json(
				{ error: "Harness callback rejected" },
				{ status: 409 },
			);
		}
	}
	const start = harnessStart.safeParse(value);
	if (!start.success)
		return Response.json({ error: "Invalid harness request" }, { status: 400 });
	if (
		channels.size >= 32 ||
		[...channels.values()].filter((c) => c.accountId === accountId).length >= 2
	)
		return Response.json(
			{ error: "An editing harness is already busy" },
			{ status: 429 },
		);
	const controller = new AbortController();
	let channel: HarnessChannel;
	const abort = () => {
		controller.abort();
		channel?.close();
	};
	request.signal.addEventListener("abort", abort, { once: true });
	if (request.signal.aborted) abort();
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(stream) {
			const send = (event: HarnessEvent) => {
				controller.signal.throwIfAborted();
				stream.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
			};
			channel = new HarnessChannel({
				accountId,
				projectId: start.data.projectId,
				send,
				signal: controller.signal,
			});
			channels.set(channel.id, channel);
			const heartbeat = setInterval(() => {
				try {
					stream.enqueue(encoder.encode("\n"));
				} catch {
					abort();
				}
			}, 20_000);
			heartbeat.unref?.();
			void (async () => {
				try {
					send({ type: "ready", runId: channel.id, token: channel.token });
					const phase = await runDeepseekEditorHarness({
						id: channel.id,
						model: start.data.model,
						bridge: channel,
						signal: controller.signal,
					});
					send({ type: "done", phase });
				} catch (error) {
					if (!controller.signal.aborted)
						send({
							type: "error",
							message: (error instanceof Error
								? error.message
								: "Editing harness failed"
							).slice(0, 2000),
						});
				} finally {
					clearInterval(heartbeat);
					channel.close();
					channels.delete(channel.id);
					request.signal.removeEventListener("abort", abort);
					try {
						stream.close();
					} catch {
						/* Consumer already closed. */
					}
				}
			})();
		},
		cancel() {
			abort();
		},
	});
	return new Response(body, {
		headers: {
			"Content-Type": "application/x-ndjson",
			"Cache-Control": "no-store, no-transform",
			"X-Accel-Buffering": "no",
			"X-OpenCut-Harness": "deepseek/0.2.2-alpha.2",
		},
	});
}
