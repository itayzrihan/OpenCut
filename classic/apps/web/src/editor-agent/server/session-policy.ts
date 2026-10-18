import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Host scheduling only. Both adapters run the identical canonical Rust policy. */
export async function runSessionPolicy({
	record,
	accountId,
	projectId,
	request,
	nowMs,
}: {
	record: string;
	accountId: string;
	projectId: string;
	request: unknown;
	nowMs: number;
}): Promise<unknown> {
	const binary =
		process.env.OPENCUT_SESSION_POLICY_BINARY ??
		resolve(process.cwd(), "../../../opencut-session-policy");
	if (!existsSync(binary)) {
		// Small development/test fixtures retain the portable WASM adapter.
		// Never allow a large save to freeze all media requests on this host.
		if (record.length > 8_000_000 || JSON.stringify(request).length > 8_000_000)
			throw new Error(
				"Native session policy is required for this large project. Rebuild local production.",
			);
		const { sessionStoreTransition } =
			await import("opencut-editor-runtime-wasm");
		return sessionStoreTransition(record, accountId, projectId, request, nowMs);
	}
	const input = JSON.stringify({
		record,
		accountId,
		projectId,
		request,
		nowMs,
	});
	if (Buffer.byteLength(input) > 256 * 1024 ** 2)
		throw new Error("Session policy input exceeds its limit");
	return new Promise((resolveResult, reject) => {
		const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let bytes = 0;
		let error = "";
		const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 320 * 1024 ** 2) child.kill("SIGKILL");
			else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			error = (error + chunk.toString()).slice(-4096);
		});
		child.stdin.on("error", () => {}); // close reports policy failures, including EPIPE
		child.on("error", (failure) => {
			clearTimeout(timeout);
			reject(failure);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (code !== 0)
				return reject(
					new Error(
						error ||
							"Native session validation stopped or timed out. Your previous save is preserved.",
					),
				);
			try {
				resolveResult(JSON.parse(Buffer.concat(chunks).toString()));
			} catch (failure) {
				reject(failure);
			}
		});
		child.stdin.end(input);
	});
}
