/** Responses SSE transport. Deltas are display-only; callers receive a tool
 * response only after the provider's explicit successful terminal event. */
export interface AgentStreamEvent {
	type: "text" | "summary" | "tool";
	text: string;
}

/** No completed response has escaped the parser, so retrying transport cannot
 * replay an editor action. Protocol/provider errors are deliberately separate. */
export class AgentStreamDisconnected extends Error {}
export class AgentProviderFailure extends Error {
	readonly failure: {
		kind: "http" | "providerFailure";
		status?: number;
		code?: string;
		retryAfterMs?: number;
	};
	constructor({
		message,
		failure,
	}: {
		message: string;
		failure: AgentProviderFailure["failure"];
	}) {
		super(message);
		this.failure = failure;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> | null {
	return isObject(value) ? value : null;
}

export async function readAgentResponse({
	response,
	signal,
	onEvent,
}: {
	response: Response;
	signal: AbortSignal;
	onEvent: (event: AgentStreamEvent) => void;
}): Promise<unknown> {
	if (!response.ok) {
		const value: unknown = await response.json().catch(() => null);
		const error = object(value)?.error;
		const details = object(error);
		const retryAfter = response.headers.get("retry-after");
		const seconds = retryAfter === null ? NaN : Number(retryAfter);
		throw new AgentProviderFailure({
			message:
				typeof error === "string"
					? error
					: typeof details?.message === "string"
						? details.message
						: `ChatGPT request failed (${response.status})`,
			failure: {
				kind: "http",
				status: response.status,
				...(typeof details?.code === "string" ? { code: details.code } : {}),
				...(Number.isFinite(seconds) && seconds >= 0
					? { retryAfterMs: Math.round(seconds * 1000) }
					: {}),
			},
		});
	}
	if (
		!response.headers.get("content-type")?.includes("text/event-stream") ||
		!response.body
	)
		throw new Error("ChatGPT did not return a response stream");
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let line = "",
		data: string[] = [],
		pendingCR = false,
		eventBytes = 0,
		total = 0;
	let completed: unknown;
	// Some subscription transports omit output from response.completed. Only
	// output_item.done is authoritative; added items and argument deltas must
	// never become executable calls, even if the response later completes.
	const finished = new Map<number, Record<string, unknown>>();
	const shape = { added: 0, done: 0, textDeltas: 0, toolItems: 0 };
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	const dispatch = () => {
		if (!data.length) return;
		const raw = data.join("\n");
		data = [];
		eventBytes = 0;
		if (raw === "[DONE]") return;
		const event = object(JSON.parse(raw));
		if (!event || typeof event.type !== "string")
			throw new Error("Invalid ChatGPT stream event");
		if (event.type === "response.output_item.added") shape.added++;
		if (event.type === "response.output_item.done") shape.done++;
		if (event.type === "response.output_item.done") {
			const item = object(event.item);
			const index = event.output_index;
			if (
				!item ||
				typeof item.id !== "string" ||
				typeof item.type !== "string" ||
				typeof index !== "number" ||
				!Number.isInteger(index) ||
				index < 0 ||
				index >= 64
			)
				throw new Error("Invalid completed ChatGPT output item");
			const previous = finished.get(index);
			if (previous && JSON.stringify(previous) !== JSON.stringify(item))
				throw new Error("Conflicting completed ChatGPT output items");
			if (
				[...finished.entries()].some(
					([position, value]) => position !== index && value.id === item.id,
				)
			)
				throw new Error("Duplicate completed ChatGPT output identity");
			finished.set(index, item);
		}
		if (event.type === "response.output_text.delta") shape.textDeltas++;
		if (
			event.type === "response.output_item.done" &&
			object(event.item)?.type === "function_call"
		)
			shape.toolItems++;
		if (
			["response.failed", "response.incomplete", "error"].includes(event.type)
		) {
			const result = object(event.response);
			const error = object(event.error) ?? object(result?.error);
			const message = error?.message ?? event.message;
			const text =
				typeof message === "string"
					? message
					: "ChatGPT stopped before completing its response";
			if (event.type === "response.incomplete") throw new Error(text);
			throw new AgentProviderFailure({
				message: text,
				failure: {
					kind: "providerFailure",
					...(typeof error?.code === "string"
						? { code: error.code }
						: typeof error?.type === "string"
							? { code: error.type }
							: {}),
				},
			});
		}
		if (event.type === "response.completed") {
			const result = object(event.response);
			if (result?.status !== "completed" || !Array.isArray(result.output))
				throw new Error("Invalid completed ChatGPT response");
			const output = [...finished.entries()]
				.sort(([a], [b]) => a - b)
				.map(([, item]) => item);
			const terminalIds = new Set<string>();
			for (const value of result.output) {
				const item = object(value);
				if (!item || typeof item.type !== "string")
					throw new Error("Invalid completed ChatGPT output");
				if (typeof item.id === "string") {
					if (terminalIds.has(item.id))
						throw new Error("Duplicate completed ChatGPT output identity");
					terminalIds.add(item.id);
				}
				const position =
					typeof item.id === "string"
						? output.findIndex((entry) => entry.id === item.id)
						: -1;
				if (position >= 0) {
					if (output[position].type !== item.type)
						throw new Error("Conflicting completed ChatGPT output types");
					output[position] = item;
				} else output.push(item);
			}
			if (output.length > 64)
				throw new Error("ChatGPT output exceeded its item limit");
			completed = { ...result, output };
			if (process.env.NODE_ENV === "development") {
				// Transport-shape counts only: never log prompt, output, tokens,
				// reasoning or encrypted provider continuation data.
				console.debug("OpenCut response stream shape", {
					...shape,
					completedItems: result.output.length,
				});
			}
		} else if (typeof event.delta === "string") {
			if (event.type === "response.output_text.delta")
				onEvent({ type: "text", text: event.delta });
			if (event.type === "response.reasoning_summary_text.delta")
				onEvent({ type: "summary", text: event.delta });
		} else if (
			event.type === "response.output_item.added" &&
			object(event.item)?.type === "function_call"
		) {
			onEvent({ type: "tool", text: "Preparing an editor action…" });
		}
	};
	const endLine = () => {
		if (!line) dispatch();
		else if (line.startsWith("data:")) {
			const value = line.slice(5).replace(/^ /, "");
			eventBytes += value.length;
			if (eventBytes > 4_000_000)
				throw new Error("ChatGPT event exceeded its size limit");
			data.push(value);
		}
		line = "";
	};
	const consume = (text: string) => {
		for (const char of text) {
			if (pendingCR) {
				pendingCR = false;
				if (char === "\n") continue;
			}
			if (char === "\r") {
				endLine();
				pendingCR = true;
			} else if (char === "\n") endLine();
			else {
				line += char;
				if (line.length > 4_000_000)
					throw new Error("ChatGPT event exceeded its size limit");
			}
		}
	};
	try {
		for (;;) {
			signal.throwIfAborted();
			const chunk = await reader.read().catch((cause: unknown) => {
				signal.throwIfAborted();
				throw new AgentStreamDisconnected(
					"ChatGPT response connection was interrupted",
					{ cause },
				);
			});
			signal.throwIfAborted();
			if (chunk.done) {
				consume(decoder.decode());
				break;
			}
			total += chunk.value.byteLength;
			if (total > 16_000_000)
				throw new Error("ChatGPT response exceeded its size limit");
			consume(decoder.decode(chunk.value, { stream: true }));
			if (completed !== undefined) return completed;
		}
		throw new AgentStreamDisconnected(
			"ChatGPT disconnected before response.completed. No partial action was applied.",
		);
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
