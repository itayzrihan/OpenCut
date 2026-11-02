import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accountsRoot, type LocalAccount } from "./server";
import {
	createLegitateAuthorization,
	LEGITATE_ISSUER,
	matchesLegitateState,
	verifyLegitateIdToken,
} from "./legitate-oidc";

type Pending = {
	nonce: string;
	verifier: string;
	browser: string;
	redirectUri: string;
	account: LocalAccount | null;
	expires: number;
};
const globalHost = globalThis as typeof globalThis & {
	__legitatePending?: Map<string, Pending>;
};
const pending = (globalHost.__legitatePending ??= new Map<string, Pending>());
const BINDING = "legitate-primary.json";

export function legitateClientId() {
	return process.env.OPENCUT_LEGITATE_CLIENT_ID || "";
}
export function legitateStart(origin: string, account: LocalAccount | null) {
	const clientId = legitateClientId();
	if (!clientId) throw new Error("Legitate sign-in is not configured");
	for (const [key, value] of pending)
		if (value.expires <= Date.now()) pending.delete(key);
	if (pending.size >= 100) throw new Error("Too many pending sign-in requests");
	const redirectUri = `${origin}/api/accounts/legitate/callback`;
	const tx = createLegitateAuthorization({ clientId, redirectUri });
	const browser = randomBytes(32).toString("base64url");
	pending.set(tx.state, {
		nonce: tx.nonce,
		verifier: tx.verifier,
		browser,
		redirectUri,
		account,
		expires: Date.now() + 300_000,
	});
	return { url: tx.url, browser };
}

export async function legitateFinish({
	state,
	browser,
	code,
}: {
	state: string;
	browser: string;
	code: string;
}) {
	if (!state || !browser || !code || code.length > 4096)
		throw new Error("Incomplete Legitate response");
	const tx = pending.get(state);
	pending.delete(state);
	if (
		!tx ||
		tx.expires <= Date.now() ||
		!matchesLegitateState(tx.browser, browser)
	)
		throw new Error("Legitate sign-in expired");
	const clientId = legitateClientId();
	const response = await fetch(`${LEGITATE_ISSUER}/api/oidc/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: tx.redirectUri,
			client_id: clientId,
			code_verifier: tx.verifier,
		}),
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error("Legitate could not complete sign-in");
	const data: unknown = await response.json();
	if (
		!data ||
		typeof data !== "object" ||
		!("id_token" in data) ||
		typeof data.id_token !== "string" ||
		data.id_token.length > 32_768
	)
		throw new Error("Invalid Legitate response");
	const identity = await verifyLegitateIdToken({
		token: data.id_token,
		clientId,
		nonce: tx.nonce,
	});
	const subjectHash = createHash("sha256")
		.update(`${identity.issuer}\0${identity.subject}`)
		.digest("hex");
	const root = accountsRoot(),
		path = join(root, BINDING);
	await mkdir(root, { recursive: true });
	if (tx.account) {
		await writeFile(
			path,
			JSON.stringify({ subjectHash, account: tx.account }),
			{ flag: "wx", mode: 0o600 },
		).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
	}
	const binding = JSON.parse(await readFile(path, "utf8")) as {
		subjectHash: string;
		account: LocalAccount;
	};
	const left = Buffer.from(subjectHash),
		right = Buffer.from(binding.subjectHash || "");
	if (
		left.length !== right.length ||
		!timingSafeEqual(left, right) ||
		!binding.account ||
		!/^[a-f0-9-]{36}$/.test(binding.account.id) ||
		(tx.account && tx.account.id !== binding.account.id)
	)
		throw new Error("Legitate identity is not linked to this workspace");
	return binding.account;
}
