"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const LIMIT = 128 * 1024;
const MODES = new Set(["plan", "askDestructive", "fullAccess"]);
const INSPECT = new Set(["list", "read"]);
function validateScope(s) {
	if (
		!s ||
		![s.accountId, s.projectId].every(
			(v) => typeof v === "string" && v.length > 0 && v.length <= 256,
		) ||
		!Number.isSafeInteger(s.generation) ||
		s.generation < 0 ||
		!MODES.has(s.mode)
	)
		throw Error("Invalid computer permission scope");
}
function absolute(value) {
	if (
		typeof value !== "string" ||
		value.length > 4096 ||
		value.includes("\0") ||
		!path.isAbsolute(value)
	)
		throw Error("An absolute file path is required");
	return value;
}
const noEffect = (error) => Object.assign(error, { definitive: true });
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function validateOperation(op) {
	if (!op || typeof op !== "object") throw Error("Invalid computer operation");
	if (op.type === "shell") {
		if (
			typeof op.command !== "string" ||
			!op.command.trim() ||
			op.command.length > 16000 ||
			!Number.isInteger(op.timeoutMs) ||
			op.timeoutMs < 1 ||
			op.timeoutMs > 120000
		)
			throw Error("Invalid command or timeout");
		absolute(op.cwd);
	} else {
		if (
			!["list", "read", "write", "mkdir", "copy", "move", "remove"].includes(
				op.type,
			)
		)
			throw Error("Unknown computer operation");
		absolute(op.path);
		if (
			op.type === "read" &&
			(!Number.isSafeInteger(op.offset) || op.offset < 0)
		)
			throw Error("Invalid byte offset");
		if (["copy", "move"].includes(op.type)) absolute(op.destination);
		if (
			op.type === "write" &&
			(typeof op.content !== "string" ||
				Buffer.byteLength(op.content) > LIMIT ||
				!(
					op.expectedSha256 === null || /^[a-f0-9]{64}$/.test(op.expectedSha256)
				))
		)
			throw Error(
				"Write requires bounded text and an expected SHA256 or null for a new file",
			);
	}
}

/** Platform IO only. Canonical policy is selected in Rust; native grants are
 * ephemeral and fenced by generation, window and exact active editor scope. */
function createComputerService({ confirm, assertScope, spawnProcess = spawn }) {
	let grant = null,
		queue = Promise.resolve(),
		cancellation = 0;
	const processes = new Set();
	const journal = new Map();
	function cancel() {
		cancellation += 1;
		for (const stop of processes) stop();
	}
	function revoke() {
		grant = null;
		cancel();
	}
	function matches(s) {
		return (
			grant &&
			["accountId", "projectId", "generation", "mode"].every(
				(k) => grant[k] === s[k],
			)
		);
	}
	async function setAccess(scope) {
		validateScope(scope);
		revoke();
		const token = cancellation;
		if (!scope.enabled) return { enabled: false };
		await assertScope(scope);
		const allowed = await confirm({
			title: "Enable computer access?",
			message:
				scope.mode === "fullAccess"
					? "Full access: the agent can read, change and delete your files, and run commands without individual approval."
					: scope.mode === "plan"
						? "Plan: the agent can list folders and read files. Changes and terminal commands are blocked."
						: "The agent can read your files. Every file change and terminal command will ask for approval.",
			detail: `Project: ${scope.projectId}\nAccount: ${scope.accountId}`,
		});
		await assertScope(scope);
		if (!allowed || token !== cancellation) return { enabled: false };
		grant = { ...scope };
		// Retain receipts across revocation so a lost response can be reconciled.
		return { enabled: true };
	}
	async function execute(request) {
		validateScope(request);
		validateOperation(request.operation);
		if (
			typeof request.operationId !== "string" ||
			!request.operationId ||
			request.operationId.length > 512
		)
			throw Error("Missing operation identity");
		await assertScope(request);

		const key = JSON.stringify([
			request.accountId,
			request.projectId,
			request.generation,
			request.operationId,
		]);
		const fingerprint = JSON.stringify(request.operation);
		const old = journal.get(key);
		if (old) {
			if (old.fingerprint !== fingerprint)
				throw Error("Operation identity reused with different arguments");
			return old.promise;
		}
		if (!matches(request))
			throw Error("Computer access is off or permissions changed");
		if (request.mode === "plan" && !INSPECT.has(request.operation.type))
			throw Error("Plan mode allows inspection only");
		if (journal.size >= 2048)
			throw Error(
				"Computer operation budget reached; restart the editor after reconciling pending work",
			);
		const authority = grant,
			token = cancellation;
		const run = async () => {
			await assertScope(request);
			if (grant !== authority || token !== cancellation)
				throw Error("Computer permission revoked");
			if (
				!INSPECT.has(request.operation.type) &&
				request.mode !== "fullAccess"
			) {
				const allowed = await confirm({
					title: "Allow this computer operation once?",
					message:
						request.operation.type === "shell"
							? request.operation.command
							: `${request.operation.type}: ${request.operation.path}`,
					detail: JSON.stringify(request.operation, null, 2),
				});
				if (!allowed) throw Error("The user denied this computer operation");
			}
			await assertScope(request);
			if (grant !== authority || token !== cancellation)
				throw Error("Computer permission revoked before execution");
			// Return the true receipt even when a revocation follows a completed write.
			try {
				const result = await io(request.operation);
				return {
					text: typeof result === "string" ? result : JSON.stringify(result),
				};
			} catch (error) {
				error.computerEffectStarted =
					!INSPECT.has(request.operation.type) && !error.definitive;
				throw error;
			}
		};
		const promise = queue.then(run);
		queue = promise.catch(() => {});
		journal.set(key, { fingerprint, promise });
		return promise;
	}
	async function io(op) {
		switch (op.type) {
			case "list": {
				const dir = await fs.opendir(op.path),
					entries = [];
				let truncated = false;
				for await (const entry of dir) {
					if (entries.length >= 40) {
						truncated = true;
						break;
					}
					entries.push({
						name: entry.name,
						directory: entry.isDirectory(),
						symlink: entry.isSymbolicLink(),
					});
				}
				return { entries, truncated };
			}
			case "read": {
				const file = await fs.open(op.path, "r");
				try {
					const stat = await file.stat();
					if (!stat.isFile()) throw Error("Read requires a regular file");
					const bytes = Buffer.alloc(
						Math.min(4096, Math.max(0, stat.size - op.offset)),
					);
					const { bytesRead } = await file.read(
						bytes,
						0,
						bytes.length,
						op.offset,
					);
					const text = new TextDecoder("utf-8", {
						fatal: true,
						ignoreBOM: true,
					}).decode(bytes.subarray(0, bytesRead), {
						stream: op.offset + bytesRead < stat.size,
					});
					if (text.includes("\0"))
						throw Error("Binary files are not supported by UTF-8 inspection");
					const consumed = Buffer.byteLength(text);
					const hash = stat.size <= LIMIT ? sha(await file.readFile()) : null;
					// A whole-file hash supports optimistic writes for bounded text files.
					return {
						text,
						offset: op.offset,
						nextOffset: op.offset + consumed,
						size: stat.size,
						truncated: op.offset + consumed < stat.size,
						sha256: hash,
					};
				} finally {
					await file.close();
				}
			}
			case "write": {
				const file = await fs
					.open(op.path, op.expectedSha256 === null ? "wx" : "r+")
					.catch((error) => {
						throw noEffect(error);
					});
				try {
					const stat = await file.stat();
					if (!stat.isFile() || stat.size > LIMIT)
						throw Error(
							"Write supports bounded regular text files; use terminal for larger files",
						);
					if (
						op.expectedSha256 !== null &&
						sha(await file.readFile()) !== op.expectedSha256
					)
						throw noEffect(Error("File changed; read it again before writing"));
					const bytes = Buffer.from(op.content);
					let written = 0;
					while (written < bytes.length) {
						const result = await file.write(
							bytes,
							written,
							bytes.length - written,
							written,
						);
						if (!result.bytesWritten) throw Error("Incomplete write");
						written += result.bytesWritten;
					}
					await file.truncate(bytes.length);
					await file.sync();
					return { written: bytes.length, sha256: sha(bytes) };
				} finally {
					await file.close();
				}
			}
			case "mkdir":
				await fs.mkdir(op.path, { recursive: false });
				return { created: op.path };
			case "copy":
				await fs.copyFile(
					op.path,
					op.destination,
					require("node:fs").constants.COPYFILE_EXCL,
				);
				return { copied: op.destination };
			case "move":
				await fs.link(op.path, op.destination);
				await fs.unlink(op.path);
				return { moved: op.destination };
			case "remove":
				await fs.rm(op.path, { recursive: true, force: false });
				return { removed: op.path };
			case "shell":
				return terminal(op);
		}
	}
	function terminal(op) {
		return new Promise((resolve, reject) => {
			const windows = process.platform === "win32";
			const child = spawnProcess(
				windows ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
				windows ? ["/d", "/s", "/c", op.command] : ["-c", op.command],
				{
					cwd: op.cwd,
					detached: !windows,
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				},
			);
			let output = "",
				size = 0,
				reason = null;
			const stop = () => {
				reason = reason || "cancelled";
				try {
					if (windows) {
						spawnProcess("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
							windowsHide: true,
						});
					} else {
						process.kill(-child.pid, "SIGKILL");
					}
				} catch {
					child.kill("SIGKILL");
				}
			};
			processes.add(stop);
			const timer = setTimeout(() => {
				reason = "timeout";
				stop();
			}, op.timeoutMs);
			const collect = (bytes) => {
				const remaining = 6144 - size;
				output += bytes.subarray(0, Math.max(0, remaining)).toString("utf8");
				size += bytes.length;
				if (size > 6144) {
					reason = "output limit";
					stop();
				}
			};
			child.stdout.on("data", collect);
			child.stderr.on("data", collect);
			child.once("error", (error) => {
				clearTimeout(timer);
				processes.delete(stop);
				reject(noEffect(error));
			});
			child.once("close", (code, signal) => {
				clearTimeout(timer);
				processes.delete(stop);
				resolve({ output, exitCode: code, signal, stopped: reason });
			});
		});
	}
	return { setAccess, execute, revoke, cancel };
}
module.exports = { createComputerService, validateOperation, validateScope };
