/** Authentication-only stdio adapter. No agent threads, tools, or public RPC. */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { createInterface } from "node:readline";

export interface DeviceLoginProcess {
	start: Promise<{ verificationUrl: string; userCode: string }>;
	completed: Promise<Record<string, unknown>>;
	close(): Promise<void>;
}

export async function createDeviceLoginProcess(): Promise<DeviceLoginProcess> {
	const binary = process.env.OPENCUT_SERVER_AI_CODEX;
	const root = process.env.OPENCUT_SERVER_AI_PRIVATE_DIR;
	if (!binary || !root || !isAbsolute(binary) || !isAbsolute(root))
		throw new Error("Browser AI sign-in is not configured on this host.");
	const directory = await mkdtemp(join(resolve(root), "login-"));
	await mkdir(join(directory, "tmp"));
	// Never inherit the host's CODEX_HOME, API keys, config, MCPs, or auth store.
	const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
	for (const name of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC"])
		if (process.env[name]) env[name] = process.env[name];
	Object.assign(env, {
		CODEX_HOME: directory,
		HOME: directory,
		USERPROFILE: directory,
		APPDATA: directory,
		LOCALAPPDATA: directory,
		TEMP: join(directory, "tmp"),
		TMP: join(directory, "tmp"),
	});
	const child = spawn(
		binary,
		[
			"app-server",
			"--listen",
			"stdio://",
			"-c",
			'cli_auth_credentials_store="file"',
			"-c",
			"analytics.enabled=false",
			"-c",
			"check_for_update_on_startup=false",
		],
		{
			cwd: directory,
			env,
			windowsHide: true,
			stdio: ["pipe", "pipe", "ignore"],
		},
	);
	let closed = false;
	let loginId: string | undefined;
	let resolveStart!: (value: {
		verificationUrl: string;
		userCode: string;
	}) => void;
	let rejectStart!: (error: Error) => void;
	let resolveComplete!: (value: Record<string, unknown>) => void;
	let rejectComplete!: (error: Error) => void;
	const start = new Promise<{ verificationUrl: string; userCode: string }>(
		(yes, no) => {
			resolveStart = yes;
			rejectStart = no;
		},
	);
	const completed = new Promise<Record<string, unknown>>((yes, no) => {
		resolveComplete = yes;
		rejectComplete = no;
	});
	// The caller attaches handlers after process startup; avoid unhandled rejects.
	void start.catch(() => {});
	void completed.catch(() => {});
	const lines = createInterface({ input: child.stdout });
	let closePromise: Promise<void> | undefined;
	const close = () =>
		(closePromise ??= (async () => {
			closed = true;
			clearTimeout(timeout);
			clearTimeout(startTimeout);
			lines.close();
			child.stdin.end();
			if (child.exitCode === null) {
				const exited = new Promise<void>((done) =>
					child.once("exit", () => done()),
				);
				if (process.platform === "win32" && child.pid) {
					// Codex can own a code-mode helper even during initialization. Kill
					// only this process tree before removing its private temporary home.
					await new Promise<void>((done) => {
						const killer = spawn(
							join(
								process.env.SystemRoot || "C:\\Windows",
								"System32",
								"taskkill.exe",
							),
							["/PID", String(child.pid), "/T", "/F"],
							{ windowsHide: true, stdio: "ignore" },
						);
						killer.once("exit", () => done());
						killer.once("error", () => {
							child.kill();
							done();
						});
					});
				} else child.kill();
				await Promise.race([
					exited,
					new Promise<void>((done) => setTimeout(done, 2000)),
				]);
			}
			// Only remove the fresh, generated directory directly under the private root.
			if (dirname(directory) !== resolve(root))
				throw new Error("Invalid login directory");
			await rm(directory, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		})());
	const fail = () => {
		const error = new Error(
			"OpenAI sign-in could not finish. Try again; device-code sign-in may need enabling in ChatGPT Settings → Security.",
		);
		rejectStart(error);
		rejectComplete(error);
		void close().catch(() => {});
	};
	const timeout = setTimeout(fail, 10 * 60_000);
	timeout.unref();
	const startTimeout = setTimeout(fail, 45_000);
	startTimeout.unref();
	const send = (value: unknown) => {
		if (!closed) child.stdin.write(`${JSON.stringify(value)}\n`);
	};
	child.on("error", fail);
	child.stdin.on("error", fail);
	child.on("exit", () => {
		if (!closed) fail();
	});
	lines.on("line", (line) => {
		void (async () => {
			if (line.length > 100_000) return fail();
			const message = JSON.parse(line);
			if (message.error) return fail();
			if (message.id === 1) {
				send({ method: "initialized" });
				send({
					id: 2,
					method: "account/login/start",
					params: { type: "chatgptDeviceCode" },
				});
			} else if (message.id === 2) {
				const result = message.result;
				if (
					result?.type !== "chatgptDeviceCode" ||
					result.verificationUrl !== "https://auth.openai.com/codex/device" ||
					typeof result.loginId !== "string" ||
					typeof result.userCode !== "string" ||
					!/^[A-Z0-9-]{4,32}$/i.test(result.userCode)
				)
					return fail();
				loginId = result.loginId;
				clearTimeout(startTimeout);
				resolveStart({
					verificationUrl: result.verificationUrl,
					userCode: result.userCode,
				});
			} else if (
				message.method === "account/login/completed" &&
				message.params?.loginId === loginId
			) {
				if (!message.params.success) return fail();
				// Read only this newly created login's file; never the host Codex login.
				const auth = JSON.parse(
					await readFile(join(directory, "auth.json"), "utf8"),
				);
				if (!auth.tokens?.access_token || !auth.tokens?.refresh_token)
					return fail();
				const tokens = auth.tokens;
				await close();
				resolveComplete(tokens);
			}
		})().catch(fail);
	});
	send({
		id: 1,
		method: "initialize",
		params: { clientInfo: { name: "opencut", version: "1.0.0" } },
	});
	return { start, completed, close };
}
