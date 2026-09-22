import { spawn } from "node:child_process";

/** Drain both pipes and terminate the owned child when its request is cancelled. */
export function runProcess({
	command,
	args,
	cwd,
	signal,
	timeoutMs = 30 * 60 * 1000,
}: {
	command: string;
	args: string[];
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, windowsHide: true });
		let stderr = "";
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
			stderr = (stderr + chunk.toString()).slice(-4000);
		});
		child.on("error", (error) => {
			cleanup();
			reject(stopped ?? error);
		});
		child.on("close", (code) => {
			cleanup();
			if (stopped) reject(stopped);
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
