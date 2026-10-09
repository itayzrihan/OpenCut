import {
	AgentProviderFailure,
	AgentStreamDisconnected,
	readAgentResponse,
	type AgentStreamEvent,
} from "./stream";

export interface ProviderFailureInput {
	attempt: number;
	kind: string;
	status?: number;
	code?: string;
	message?: string;
	retryAfterMs?: number;
	responseApplied: boolean;
}
export interface ProviderRetryPlan {
	retry: boolean;
	delayMs: number;
	maxAttempts: number;
}

function waitForRetry({
	milliseconds,
	signal,
}: {
	milliseconds: number;
	signal: AbortSignal;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, milliseconds);
		signal.addEventListener("abort", abort, { once: true });
	});
}

/** Retry IO only, before a complete provider response is returned to Rust.
 * Rust decides bounded transient recovery. Never retry applied actions, host
 * effects, authority failures or invalid output. */
export async function requestAgentResponse({
	send,
	signal,
	beforeAttempt,
	onEvent,
	onRetry,
	planRetry,
	wait = waitForRetry,
}: {
	send: () => Promise<Response>;
	signal: AbortSignal;
	beforeAttempt: () => void;
	onEvent: (event: AgentStreamEvent) => void;
	onRetry: (attempt: number) => void;
	planRetry: (failure: ProviderFailureInput) => ProviderRetryPlan;
	wait?: typeof waitForRetry;
}): Promise<unknown> {
	for (let attempt = 1; ; attempt++) {
		signal.throwIfAborted();
		beforeAttempt();
		try {
			const response = await send().catch((cause: unknown) => {
				signal.throwIfAborted();
				if (!(cause instanceof TypeError)) throw cause;
				throw new AgentStreamDisconnected("Could not connect to ChatGPT", {
					cause,
				});
			});
			return await readAgentResponse({ response, signal, onEvent });
		} catch (error) {
			signal.throwIfAborted();
			const failure: ProviderFailureInput =
				error instanceof AgentStreamDisconnected
					? { attempt, kind: "disconnect", responseApplied: false }
					: error instanceof AgentProviderFailure
						? {
								attempt,
								...error.failure,
								message: error.message,
								responseApplied: false,
							}
						: { attempt, kind: "protocol", responseApplied: false };
			const plan = planRetry(failure);
			if (!plan.retry) throw error;
			onRetry(attempt);
			await wait({ milliseconds: plan.delayMs, signal });
		}
	}
}
