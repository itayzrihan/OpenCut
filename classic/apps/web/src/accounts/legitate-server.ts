import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accountsRoot, type LocalAccount } from "./server";
import { cachePeerIdentity } from "@/peer-sync/identity";
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
	hosted: boolean;
	expires: number;
};
const globalHost = globalThis as typeof globalThis & {
	__legitatePending?: Map<string, Pending>;
};
const pending = (globalHost.__legitatePending ??= new Map<string, Pending>());
const BINDING = "legitate-primary.json";
export const LEGITATE_SIGN_IN_TTL_SECONDS = 15 * 60;

/** First-time linking requires a signed-in local workspace in this browser. */
export async function hasLegitateWorkspaceBinding() {
	try {
		const binding = JSON.parse(
			await readFile(join(accountsRoot(), BINDING), "utf8"),
		);
		return (
			typeof binding.subjectHash === "string" &&
			/^[a-f0-9]{64}$/.test(binding.subjectHash) &&
			typeof binding.account?.id === "string" &&
			/^[a-f0-9-]{36}$/.test(binding.account.id)
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

type SignInStage =
	| "transaction"
	| "token_exchange"
	| "token_response"
	| "id_token_validation"
	| "workspace_binding"
	| "peer_identity_cache";
export const LEGITATE_IDENTITY_CONSENT_REQUIRED =
	"ERR_LEGITATE_IDENTITY_CONSENT_REQUIRED";

export class LegitateSignInFailure extends Error {
	readonly diagnostics: {
		stage: SignInStage;
		code?: string;
		claim?: string;
		httpStatus?: number;
	};
	constructor({
		stage,
		error,
		httpStatus,
	}: {
		stage: SignInStage;
		error: unknown;
		httpStatus?: number;
	}) {
		const expired =
			error instanceof Error &&
			["Legitate sign-in expired", "Incomplete Legitate response"].includes(
				error.message,
			);
		super(
			expired && error instanceof Error
				? error.message
				: "Legitate sign-in could not be completed",
		);
		const detail = error as { code?: unknown; claim?: unknown } | null;
		this.diagnostics = {
			stage,
			...(typeof detail?.code === "string" &&
			/^ERR_[A-Z_]{1,72}$/.test(detail.code)
				? { code: detail.code }
				: {}),
			...(typeof detail?.claim === "string" &&
			["iss", "sub", "aud", "exp", "iat", "nonce", "azp"].includes(detail.claim)
				? { claim: detail.claim }
				: {}),
			...(httpStatus !== undefined ? { httpStatus } : {}),
		};
	}
}

export function legitateClientId() {
	return process.env.OPENCUT_LEGITATE_CLIENT_ID || "";
}
export function legitateHostedOrigin() {
	if (process.env.OPENCUT_LEGITATE_HOSTED !== "true") return undefined;
	const origin = process.env.OPENCUT_PUBLIC_ORIGIN;
	if (
		process.env.OPENCUT_LEGITATE_ONLY !== "true" ||
		!origin ||
		!origin.startsWith("https://") ||
		new URL(origin).origin !== origin
	)
		throw new Error("Hosted Legitate requires an exact HTTPS origin and Legitate-only mode");
	return origin;
}

function hostedAccount(subjectHash: string): LocalAccount {
	// UUIDv8 derived from the verified issuer and subject. A stable namespace
	// avoids first-login races and keeps each account's editor data separate.
	const variant = ((parseInt(subjectHash[16], 16) & 3) | 8).toString(16);
	const id = `${subjectHash.slice(0, 8)}-${subjectHash.slice(8, 12)}-8${subjectHash.slice(13, 16)}-${variant}${subjectHash.slice(17, 20)}-${subjectHash.slice(20, 32)}`;
	return { id, login: `legitate-${id}`, displayName: "Legitate" };
}

export function legitateStart(origin: string, account: LocalAccount | null) {
	const clientId = legitateClientId();
	if (!clientId) throw new Error("Legitate sign-in is not configured");
	for (const [key, value] of pending)
		if (value.expires <= Date.now()) pending.delete(key);
	if (pending.size >= 100) throw new Error("Too many pending sign-in requests");
	const redirectUri = `${origin}/api/accounts/legitate/callback`;
	const hostedOrigin = legitateHostedOrigin();
	const tx = createLegitateAuthorization({ clientId, redirectUri, hostedOrigin });
	const browser = randomBytes(32).toString("base64url");
	pending.set(tx.state, {
		nonce: tx.nonce,
		verifier: tx.verifier,
		browser,
		redirectUri,
		account,
		hosted: !!hostedOrigin,
		expires: Date.now() + LEGITATE_SIGN_IN_TTL_SECONDS * 1000,
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
	let stage: SignInStage = "transaction";
	let httpStatus: number | undefined;
	try {
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
		stage = "token_exchange";
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
		httpStatus = response.status;
		if (!response.ok) throw new Error("Legitate could not complete sign-in");
		stage = "token_response";
		const data: unknown = await response.json();
		if (
			!data ||
			typeof data !== "object" ||
			!("id_token" in data) ||
			typeof data.id_token !== "string" ||
			data.id_token.length > 32_768
		) {
			if (
				data &&
				typeof data === "object" &&
				"scope" in data &&
				typeof data.scope === "string" &&
				!data.scope.split(/\s+/).includes("openid")
			)
				throw Object.assign(new Error("Legitate identity was not shared"), {
					code: LEGITATE_IDENTITY_CONSENT_REQUIRED,
				});
			throw new Error("Invalid Legitate response");
		}
		stage = "id_token_validation";
		const identity = await verifyLegitateIdToken({
			token: data.id_token,
			clientId,
			nonce: tx.nonce,
		});
		const subjectHash = createHash("sha256")
			.update(`${identity.issuer}\0${identity.subject}`)
			.digest("hex");
		if (tx.hosted) return hostedAccount(subjectHash);
		stage = "workspace_binding";
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
		stage = "peer_identity_cache";
		await cachePeerIdentity({
			accountId: binding.account.id,
			subjectHash,
			idToken: data.id_token,
		});
		return binding.account;
	} catch (error) {
		throw new LegitateSignInFailure({ stage, error, httpStatus });
	}
}
