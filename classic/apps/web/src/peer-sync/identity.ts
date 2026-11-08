/** Private host credentials. Neither bearer proofs nor device private keys are
 * stored in project snapshots, returned to the browser, or sent to other peers. */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	writeFile,
	rename,
	link,
	unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { accountsRoot, requireAccount } from "@/accounts/server";

const safeId = /^[a-zA-Z0-9_-]{1,160}$/;
export const DEFAULT_PEER_RELAY_URL =
	"https://opencut-peer-sync.85-215-209-220.sslip.io";
export async function cachePeerIdentity({
	accountId,
	subjectHash,
	idToken,
}: {
	accountId: string;
	subjectHash: string;
	idToken: string;
}) {
	if (
		!safeId.test(accountId) ||
		!/^[a-f0-9]{64}$/.test(subjectHash) ||
		typeof idToken !== "string" ||
		idToken.length > 32768
	)
		throw new Error("Invalid verified identity proof");
	const directory = join(accountsRoot(), "peer-credentials");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const target = join(directory, `${accountId}.json`),
		temporary = `${target}.${randomUUID()}.tmp`;
	await writeFile(
		temporary,
		JSON.stringify({ accountId, subjectHash, idToken }),
		{ flag: "wx", mode: 0o600 },
	);
	await rename(temporary, target);
}
export async function peerIdentityProof() {
	const accountId = requireAccount().id;
	const [proof, binding] = await Promise.all([
		readFile(
			join(accountsRoot(), "peer-credentials", `${accountId}.json`),
			"utf8",
		).then(JSON.parse),
		readFile(join(accountsRoot(), "legitate-primary.json"), "utf8").then(
			JSON.parse,
		),
	]);
	if (
		proof.accountId !== accountId ||
		binding.account?.id !== accountId ||
		proof.subjectHash !== binding.subjectHash ||
		typeof proof.idToken !== "string" ||
		proof.idToken.length > 32768
	)
		throw new Error("Sign in through Legitate to connect your devices");
	return {
		idToken: proof.idToken as string,
		owner: proof.subjectHash as string,
	};
}
export type PeerIdentity = {
	id: string;
	name: string;
	publicKey: string;
	privateKey: string;
};
function directory() {
	return join(accountsRoot(), "peer-devices", requireAccount().id);
}
export async function peerDeviceIdentity(): Promise<PeerIdentity> {
	const path = join(directory(), "identity.json");
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(directory(), { recursive: true, mode: 0o700 });
	const keys = generateKeyPairSync("x25519");
	const identity = {
		id: randomUUID(),
		name: hostname(),
		publicKey: keys.publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
		privateKey: keys.privateKey
			.export({ type: "pkcs8", format: "pem" })
			.toString(),
	};
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(identity), {
		flag: "wx",
		mode: 0o600,
	});
	try {
		await link(temporary, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally {
		await unlink(temporary);
	}
	return JSON.parse(await readFile(path, "utf8"));
}
export async function peerSharingEnabled(): Promise<boolean> {
	try {
		return (
			JSON.parse(await readFile(join(directory(), "settings.json"), "utf8"))
				.enabled === true
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
export async function setPeerSharingEnabled(enabled: boolean) {
	await mkdir(directory(), { recursive: true, mode: 0o700 });
	const path = join(directory(), "settings.json"),
		temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify({ enabled }), {
		flag: "wx",
		mode: 0o600,
	});
	await rename(temporary, path);
}
export function configuredRelayUrl(): string | null {
	const value = process.env.OPENCUT_SYNC_RELAY_URL ?? DEFAULT_PEER_RELAY_URL;
	if (!value) return null;
	const url = new URL(value);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
			))
	)
		throw new Error(
			"The device relay must use HTTPS, or loopback HTTP for local testing",
		);
	return url.origin;
}
