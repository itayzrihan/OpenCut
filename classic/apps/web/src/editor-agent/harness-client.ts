import {
	harnessEvent,
	type HarnessCall,
	type HarnessPhase,
} from "./harness-protocol";

/** HTTP glue for DSH's server loop. No retry after dispatch: a lost callback
 * acknowledgement pauses the canonical run for receipt reconciliation. */
export async function driveEditorHarness({
	accountId,
	projectId,
	model,
	signal,
	assertScope,
	call,
	send = fetch,
}: {
	accountId: string;
	projectId: string;
	model: string;
	signal: AbortSignal;
	assertScope(): void;
	call(operation: HarnessCall["operation"], round: number): Promise<unknown>;
	send?: typeof fetch;
}): Promise<HarnessPhase> {
	assertScope();
	signal.throwIfAborted();
	const headers = {
		"Content-Type": "application/json",
		"X-OpenCut-Account": accountId,
	};
	const response = await send("/api/editor-agent/harness", {
		method: "POST",
		credentials: "same-origin",
		cache: "no-store",
		signal,
		headers,
		body: JSON.stringify({ type: "start", projectId, model }),
	});
	if (
		!response.ok ||
		!response.body ||
		!response.headers.get("Content-Type")?.includes("application/x-ndjson")
	)
		throw new Error("The editing harness is unavailable");
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "",
		identity: { runId: string; token: string } | undefined;
	let phase: HarnessPhase | undefined;
	let nextRound = 1,
		nextOperation: HarnessCall["operation"] = "provider";
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			signal.throwIfAborted();
			const { value, done } = await reader.read();
			buffer += done
				? decoder.decode()
				: decoder.decode(value, { stream: true });
			if (buffer.length > 64_000)
				throw new Error("Harness event exceeds its bound");
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				const event = harnessEvent.parse(JSON.parse(line));
				signal.throwIfAborted();
				assertScope();
				if (phase !== undefined)
					throw new Error("Harness emitted an event after completion");
				if (event.type === "ready") {
					if (identity) throw new Error("Harness identity changed");
					identity = { runId: event.runId, token: event.token };
				} else if (event.type === "error") throw new Error(event.message);
				else if (event.type === "done") {
					if (
						!identity ||
						nextOperation !== "provider" ||
						!["completed", "failed", "paused"].includes(event.phase)
					)
						throw new Error(
							"Harness completed with an unsettled editor callback",
						);
					phase = event.phase;
				} else {
					if (
						!identity ||
						event.operation !== nextOperation ||
						event.round !== nextRound
					)
						throw new Error("Stale or out-of-order harness callback");
					let result: unknown, error: string | undefined;
					try {
						result = await call(event.operation, event.round);
					} catch (failure) {
						error = (
							failure instanceof Error
								? failure.message
								: "Editor callback failed"
						).slice(0, 2000);
					}
					signal.throwIfAborted();
					assertScope();
					const acknowledged = await send("/api/editor-agent/harness", {
						method: "POST",
						credentials: "same-origin",
						cache: "no-store",
						signal,
						headers,
						body: JSON.stringify({
							type: "reply",
							...identity,
							projectId,
							callId: event.callId,
							...(error ? { error } : { result }),
						}),
					});
					if (!acknowledged.ok)
						throw new Error(
							"Harness acknowledgement lost; reconcile the editor before resuming",
						);
					if (error) throw new Error(error);
					if (nextOperation === "apply") {
						nextRound++;
						nextOperation = "provider";
					} else nextOperation = "apply";
				}
			}
			if (done) break;
		}
		signal.throwIfAborted();
		assertScope();
		if (buffer.trim() || phase === undefined)
			throw new Error(
				"Harness disconnected; resume from the canonical checkpoint",
			);
		return phase;
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
