import { spawn } from "node:child_process";

/** Drain both pipes and terminate the owned child when its request is cancelled. */
export function runProcess({
	command,
	args,
	cwd,
	signal,
	timeoutMs = 30 * 60 * 1000,
	requiredStderrPattern,
}: {
	command: string;
	args: string[];
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Require runtime evidence, not merely a GPU-capable build. */
	requiredStderrPattern?: RegExp;
}): Promise<void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, windowsHide: true });
		let stderr = "";
		let requirementMet = !requiredStderrPattern;
		let stopped: Error | undefined;
		const stop = (error: Error) => {
			stopped ??= error;
			child.kill("SIGKILL");
		};
		const abort = () => stop(new Error("Transcription cancelled"));
		const timeout = setTimeout(
			() => stop(new Error("Transcription process timed out")),
			timeoutMs,
		);
		const cleanup = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		child.stdout.resume();
		child.stderr.on("data", (chunk) => {
			const output = stderr + chunk.toString();
			if (requiredStderrPattern?.test(output)) requirementMet = true;
			stderr = output.slice(-4000);
		});
		child.on("error", (error) => {
			cleanup();
			reject(stopped ?? error);
		});
		child.on("close", (code) => {
			cleanup();
			if (stopped) reject(stopped);
			else if (code === 0 && !requirementMet)
				reject(
					new Error(
						"Whisper did not confirm an active GPU backend. Check the GPU-enabled binary and drivers; CPU fallback is disabled.",
					),
				);
			else if (code === 0) resolve();
			else
				reject(
					new Error(
						stderr.slice(-1000) || `Transcription process exited with ${code}`,
					),
				);
		});
	});
}
