/** Local host identity adapter. Editor policy lives in the shared Rust core. */
import { AsyncLocalStorage } from "node:async_hooks";
import {
	createHash,
	randomBytes,
	randomUUID,
	scrypt,
	timingSafeEqual,
} from "node:crypto";
import {
	mkdir,
	readFile,
	writeFile,
	unlink,
	rename,
	readdir,
	stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { recoverInterruptedRestores } from "./restore-recovery";

const derive = promisify(scrypt);
const COOKIE = "opencut-account";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export interface LocalAccount {
	id: string;
	displayName: string;
	login: string;
}
interface Credential extends LocalAccount {
	salt: string;
	verifier: string;
}
interface Session {
	accountId: string;
	expiresAt: number;
}
export const accountScope = new AsyncLocalStorage<LocalAccount>();
const failures = new Map<string, { count: number; until: number }>();
const host = globalThis as typeof globalThis & {
	__opencutAccountImports?: Set<string>;
	__opencutAccountWrites?: Map<string, Promise<unknown>>;
};
const activeImports = (host.__opencutAccountImports ??= new Set<string>());
const accountWrites = (host.__opencutAccountWrites ??= new Map<
	string,
	Promise<unknown>
>());
function importLockPath(id: string) {
	return join(accountsRoot(), "import-locks", `${id}.json`);
}
export async function importLocked(id: string) {
	if (activeImports.has(id)) return true;
	let lock: { pid: number };
	try {
		lock = JSON.parse(await readFile(importLockPath(id), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	try {
		process.kill(lock.pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
		// Keep interrupted staging and the lock as evidence; only the dead host's
		// lock is retired. A live second host is never allowed to race an import.
		await rename(
			importLockPath(id),
			`${importLockPath(id)}.interrupted-${randomUUID()}`,
		).catch((e) => {
			if (e.code !== "ENOENT") throw e;
		});
		return false;
	}
}
export async function accountDataLocked(id: string) {
	if (!(await importLocked(id))) return false;
	const lock = await readFile(importLockPath(id), "utf8")
		.then((raw) => JSON.parse(raw))
		.catch((error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
	return !!lock && lock.mode !== "snapshot";
}
export async function markAccountImport(
	id: string,
	active: boolean,
	mode: "exclusive" | "snapshot" = "exclusive",
) {
	if (active && activeImports.has(id))
		throw new Error("An import is already running");
	if (active) {
		if (await importLocked(id))
			throw new Error("An import is already running in another host");
		await mkdir(join(accountsRoot(), "import-locks"), { recursive: true });
		await writeFile(
			importLockPath(id),
			JSON.stringify({
				pid: process.pid,
				mode,
				startedAt: new Date().toISOString(),
			}),
			{ flag: "wx" },
		);
		activeImports.add(id);
	} else {
		await unlink(importLockPath(id)).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		activeImports.delete(id);
	}
}

export function accountsRoot() {
	return resolve(
		process.env.OPENCUT_ACCOUNTS_DIR ||
			join(homedir(), "Movies", "OpenCut Accounts"),
	);
}
export function requireAccount() {
	const account = accountScope.getStore();
	if (!account) throw new Error("Sign in to an OpenCut account first");
	return account;
}
export function accountDataRoot() {
	return join(accountsRoot(), "data", requireAccount().id);
}
export function assertLocalOrigin(request: Request) {
	const url = new URL(request.url);
	// Next may normalize request.url to localhost even when the browser used
	// 127.0.0.1. Validate the actual Host as well as the internal URL.
	const hostHeader = request.headers.get("host");
	const actual = hostHeader ? new URL(`${url.protocol}//${hostHeader}`) : url;
	if (
		![url, actual].every((value) =>
			["localhost", "127.0.0.1", "[::1]"].includes(value.hostname),
		)
	)
		throw new Error("This storage host is available only on loopback");
	const origin = request.headers.get("origin");
	if (origin && origin !== actual.origin)
		throw new Error("Cross-origin request rejected");
	const site = request.headers.get("sec-fetch-site");
	if (
		site &&
		![
			"same-origin",
			"none",
			...(request.method === "GET" ? ["same-site"] : []),
		].includes(site)
	)
		throw new Error("Cross-origin request rejected");
}
function digest(value: string) {
	return createHash("sha256").update(value).digest("hex");
}
function normalizeLogin(login: string) {
	const value = login.trim().normalize("NFKC").toLowerCase();
	if (value.length < 3 || value.length > 128 || /[\x00-\x1f]/.test(value))
		throw new Error("Use an account name of 3–128 characters");
	return value;
}
function credentialPath(login: string) {
	return join(accountsRoot(), "identity", `${digest(login)}.json`);
}
function sessionPath(token: string) {
	return join(accountsRoot(), "sessions", `${digest(token)}.json`);
}
function publicAccount(value: Credential): LocalAccount {
	return { id: value.id, displayName: value.displayName, login: value.login };
}
async function newSession(account: LocalAccount) {
	const token = randomBytes(32).toString("hex");
	await mkdir(join(accountsRoot(), "sessions"), { recursive: true });
	await writeFile(
		sessionPath(token),
		JSON.stringify({
			accountId: account.id,
			expiresAt: Date.now() + SESSION_MS,
			account,
		}),
		{ flag: "wx", mode: 0o600 },
	);
	return { account, token };
}
export async function registerAccount(
	login: string,
	displayName: string,
	password: string,
) {
	login = normalizeLogin(login);
	if (password.length < 12 || password.length > 1024)
		throw new Error("Use a password of 12–1024 characters");
	displayName = displayName.trim();
	if (
		!displayName ||
		displayName.length > 128 ||
		/[\x00-\x1f]/.test(displayName)
	)
		throw new Error("Enter a display name");
	const salt = randomBytes(32).toString("hex");
	const verifier = Buffer.from(
		(await derive(password, salt, 64)) as Buffer,
	).toString("hex");
	const credential: Credential = {
		id: randomUUID(),
		login,
		displayName,
		salt,
		verifier,
	};
	await mkdir(join(accountsRoot(), "identity"), { recursive: true });
	await writeFile(credentialPath(login), JSON.stringify(credential), {
		flag: "wx",
		mode: 0o600,
	});
	// The first local account owns the pre-account installation's import grant.
	await writeFile(
		join(accountsRoot(), "legacy-owner.json"),
		JSON.stringify({ accountId: credential.id }),
		{ flag: "wx", mode: 0o600 },
	).catch((error) => {
		if (error.code !== "EEXIST") throw error;
	});
	return newSession(publicAccount(credential));
}

export async function canImportLegacy() {
	const owner = await readFile(
		join(accountsRoot(), "legacy-owner.json"),
		"utf8",
	).then(JSON.parse);
	return owner.accountId === requireAccount().id;
}
export async function loginAccount(login: string, password: string) {
	login = normalizeLogin(login);
	if (password.length > 1024) throw new Error("Invalid credentials");
	const key = digest(login);
	const recent = failures.get(key);
	if (recent && recent.count >= 5 && recent.until > Date.now())
		throw new Error("Too many attempts. Try again in a few minutes");
	if (failures.size > 1000)
		for (const [id, value] of failures)
			if (value.until < Date.now()) failures.delete(id);
	failures.set(key, {
		count: recent && recent.until > Date.now() ? recent.count + 1 : 1,
		until: Date.now() + 300_000,
	});
	const credential = await readFile(credentialPath(login), "utf8")
		.then((text) => JSON.parse(text) as Credential)
		.catch((error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
	const actual = Buffer.from(
		(await derive(
			password,
			credential?.salt || "unregistered-account",
			64,
		)) as Buffer,
	);
	if (
		!credential ||
		!timingSafeEqual(actual, Buffer.from(credential.verifier, "hex"))
	)
		throw new Error("Invalid credentials");
	failures.delete(key);
	return newSession(publicAccount(credential));
}
export async function verifyCurrentAccountPassword(password: string) {
	if (typeof password !== "string" || password.length > 1024)
		throw new Error("Invalid password");
	const account = requireAccount(),
		credential: Credential = JSON.parse(
			await readFile(credentialPath(account.login), "utf8"),
		);
	const actual = Buffer.from(
		(await derive(password, credential.salt, 64)) as Buffer,
	);
	if (
		credential.id !== account.id ||
		!timingSafeEqual(actual, Buffer.from(credential.verifier, "hex"))
	)
		throw new Error("Invalid password");
}
export async function changeAccountPassword(
	currentPassword: string,
	password: string,
) {
	if (password.length < 12 || password.length > 1024)
		throw new Error("Use a password of 12–1024 characters");
	await verifyCurrentAccountPassword(currentPassword);
	const account = requireAccount();
	const credential: Credential = JSON.parse(
		await readFile(credentialPath(account.login), "utf8"),
	);
	const salt = randomBytes(32).toString("hex");
	const verifier = Buffer.from(
		(await derive(password, salt, 64)) as Buffer,
	).toString("hex");
	const temporary = `${credentialPath(account.login)}.${randomUUID()}.tmp`;
	await writeFile(
		temporary,
		JSON.stringify({ ...credential, salt, verifier }),
		{ flag: "wx", mode: 0o600 },
	);
	await rename(temporary, credentialPath(account.login));
	for (const name of await readdir(join(accountsRoot(), "sessions"))) {
		const path = join(accountsRoot(), "sessions", name);
		const session = await readFile(path, "utf8")
			.then(JSON.parse)
			.catch(() => null);
		if (session?.accountId === account.id)
			await unlink(path).catch((error) => {
				if (error.code !== "ENOENT") throw error;
			});
	}
	return newSession(account);
}

export async function installRecoveredAccount(
	account: LocalAccount,
	key: Buffer,
	password: string,
) {
	if (
		!/^[a-f0-9-]{36}$/.test(account.id) ||
		key.length !== 32 ||
		!account.displayName?.trim() ||
		account.displayName.length > 128
	)
		throw new Error("Invalid account recovery data");
	if (password.length < 12 || password.length > 1024)
		throw new Error("Invalid recovery password length");
	const login = normalizeLogin(account.login),
		identityRoot = join(accountsRoot(), "identity");
	await mkdir(identityRoot, { recursive: true });
	for (const file of await readdir(identityRoot)) {
		if (!file.endsWith(".json")) continue;
		const existing = JSON.parse(
			await readFile(join(identityRoot, file), "utf8"),
		);
		if (existing.id === account.id || existing.login === login)
			throw new Error(
				"This account already exists on this machine. Sign in; recovery never overwrites an account.",
			);
	}
	if (
		await stat(join(accountsRoot(), "data", account.id))
			.then(() => true)
			.catch((error) => {
				if (error.code === "ENOENT") return false;
				throw error;
			})
	)
		throw new Error(
			"Account data already exists. Recovery will not replace it.",
		);
	await mkdir(join(accountsRoot(), "identity-claims"), { recursive: true });
	const claimPath = join(accountsRoot(), "identity-claims", account.id),
		claim = digest(`${login}:${key.toString("hex")}`);
	try {
		await writeFile(claimPath, claim, { flag: "wx" });
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== "EEXIST" ||
			(await readFile(claimPath, "utf8")) !== claim
		)
			throw error;
	}
	const salt = randomBytes(32).toString("hex"),
		verifier = Buffer.from(
			(await derive(password, salt, 64)) as Buffer,
		).toString("hex");
	await mkdir(join(accountsRoot(), "storage-keys"), { recursive: true });
	const keyPath = join(accountsRoot(), "storage-keys", `${account.id}.key`);
	try {
		await writeFile(keyPath, key, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== "EEXIST" ||
			!(await readFile(keyPath)).equals(key)
		)
			throw error;
	}
	const credential: Credential = { ...account, login, salt, verifier };
	await writeFile(credentialPath(login), JSON.stringify(credential), {
		flag: "wx",
		mode: 0o600,
	});
	await writeFile(
		join(accountsRoot(), "legacy-owner.json"),
		JSON.stringify({ accountId: account.id }),
		{ flag: "wx", mode: 0o600 },
	).catch((error) => {
		if (error.code !== "EEXIST") throw error;
	});
	return newSession(publicAccount(credential));
}
function readToken(request: Request) {
	const token = request.headers
		.get("cookie")
		?.split(";")
		.map((v) => v.trim())
		.find((v) => v.startsWith(`${COOKIE}=`))
		?.slice(COOKIE.length + 1);
	return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export async function authenticateAccount(
	request: Request,
): Promise<LocalAccount> {
	assertLocalOrigin(request);
	const token = readToken(request);
	if (!token) throw new Error("Sign in to an OpenCut account first");
	const session = await readFile(sessionPath(token), "utf8").then(
		(text) => JSON.parse(text) as Session & { account: LocalAccount },
	);
	if (
		session.expiresAt <= Date.now() ||
		!/^[a-f0-9-]{36}$/.test(session.accountId) ||
		session.account.id !== session.accountId
	)
		throw new Error("Session expired. Sign in again");
	if (!(await importLocked(session.accountId)))
		await recoverInterruptedRestores(accountsRoot(), session.accountId);
	return session.account;
}
export async function logoutAccount(request: Request) {
	assertLocalOrigin(request);
	const token = readToken(request);
	if (token)
		await unlink(sessionPath(token)).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
}
export function sessionCookie(token: string) {
	return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? SESSION_MS / 1000 : 0}`;
}
export function withAccount<R extends Request, T extends unknown[]>(
	handler: (request: R, ...args: T) => Promise<Response>,
) {
	return async (request: R, ...args: T): Promise<Response> => {
		let account: LocalAccount;
		try {
			account = await authenticateAccount(request);
		} catch {
			return Response.json(
				{ error: "Sign in to access this account's data" },
				{ status: 401, headers: { "Cache-Control": "no-store" } },
			);
		}
		const url = new URL(request.url);
		const expected =
			request.headers.get("X-OpenCut-Account") ||
			url.searchParams.get("account");
		if (expected && expected !== account.id)
			return Response.json(
				{ error: "Account changed. Reload this workspace." },
				{ status: 409 },
			);
		const run = () =>
			accountScope.run(account, async () => {
				if (
					!url.pathname.startsWith("/api/accounts/") &&
					(await accountDataLocked(account.id))
				)
					return Response.json(
						{ error: "Account import or version activation is in progress" },
						{ status: 423 },
					);
				const response = await handler(request, ...args);
				response.headers.set("Cache-Control", "private, no-store");
				response.headers.set("Vary", "Cookie");
				response.headers.set("X-Content-Type-Options", "nosniff");
				// Uploaded SVG/HTML-like bytes must never execute with the account
				// host's origin if opened directly as a document.
				if (!response.headers.has("Content-Security-Policy"))
					response.headers.set("Content-Security-Policy", "sandbox");
				return response;
			});
		if (["GET", "HEAD"].includes(request.method)) return run();
		const pending = (accountWrites.get(account.id) ?? Promise.resolve())
			.catch(() => {})
			.then(run);
		accountWrites.set(account.id, pending);
		try {
			return await pending;
		} finally {
			if (accountWrites.get(account.id) === pending)
				accountWrites.delete(account.id);
		}
	};
}
