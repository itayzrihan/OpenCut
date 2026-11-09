import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { accountsRoot, localRequestOrigin } from "@/accounts/server";
import { isLoopbackHostname } from "./classic-bridge";

const activationLifetime = 15 * 60_000;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.object({
	projectId: z.string().min(1).max(256),
	pending: z.object({ hash: digestSchema, expiresAt: z.number() }).optional(),
	active: digestSchema.optional(),
});

export type McpCredential = {
	accountId: string;
	projectHash: string;
	token: string;
};
type Record = z.infer<typeof recordSchema>;

function hash(value: string) {
	return createHash("sha256").update(value).digest("hex");
}
function matches(left: string, right: string) {
	return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function directory({
	accountId,
	projectHash,
}: Pick<McpCredential, "accountId" | "projectHash">) {
	return join(
		accountsRoot(),
		"data",
		accountId,
		"editor-agent",
		"mcp",
		projectHash,
	);
}

export function mcpLocalOrigin(request: Request) {
	if (
		process.env.OPENCUT_DELEGATED_MCP_LOCAL !== "1" ||
		process.env.OPENCUT_PUBLIC_ORIGIN
	)
		throw new Error(
			"Delegated MCP is available only in a local POCUT installation.",
		);
	const origin = localRequestOrigin(request);
	if (!isLoopbackHostname(new URL(origin).hostname))
		throw new Error("Use the local POCUT app.");
	return origin;
}

export function parseMcpCredential(
	token: string,
	kind: "setup" | "key",
): McpCredential | null {
	const [prefix, accountId, projectHash, secret, extra] = token.split(".");
	if (
		prefix !== `pocut-${kind}` ||
		extra !== undefined ||
		!z.uuid().safeParse(accountId).success ||
		!digestSchema.safeParse(projectHash).success ||
		!secret ||
		!/^[\w-]{43}$/.test(secret)
	)
		return null;
	return { accountId, projectHash, token };
}

async function read(folder: string): Promise<Record | null> {
	try {
		return recordSchema.parse(
			JSON.parse(await readFile(join(folder, "access.json"), "utf8")),
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
}

async function update(
	folder: string,
	operation: (current: Record | null) => Record,
) {
	const release = await lockfile.lock(folder, {
		realpath: false,
		retries: { retries: 4, minTimeout: 50, maxTimeout: 200 },
	});
	const temporary = join(folder, `${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, JSON.stringify(operation(await read(folder))), {
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporary, join(folder, "access.json"));
	} finally {
		try {
			await rm(temporary, { force: true });
		} finally {
			await release();
		}
	}
}

export async function issueMcpInstallation({
	accountId,
	projectId,
}: {
	accountId: string;
	projectId: string;
}) {
	const projectHash = hash(projectId);
	const activation = `pocut-setup.${accountId}.${projectHash}.${randomBytes(32).toString("base64url")}`;
	const expiresAt = Date.now() + activationLifetime;
	const folder = directory({ accountId, projectHash });
	await mkdir(folder, { recursive: true, mode: 0o700 });
	await update(folder, (current) => ({
		projectId,
		active: current?.active,
		pending: { hash: hash(activation), expiresAt },
	}));
	return { activation, expiresAt };
}

export async function activateMcpInstallation({
	credential,
	keyHash,
}: {
	credential: McpCredential;
	keyHash: string;
}) {
	const folder = directory(credential);
	await update(folder, (current) => {
		if (
			!current?.pending ||
			current.pending.expiresAt <= Date.now() ||
			!matches(hash(credential.token), current.pending.hash)
		)
			throw new Error("Installation has expired or was already used.");
		return {
			projectId: current.projectId,
			active: digestSchema.parse(keyHash),
		};
	});
}

export async function authorizeMcpKey(credential: McpCredential) {
	const current = await read(directory(credential));
	return current?.active && matches(hash(credential.token), current.active)
		? current.projectId
		: null;
}

export async function revokeMcpInstallation({
	accountId,
	projectId,
}: {
	accountId: string;
	projectId: string;
}) {
	const folder = directory({ accountId, projectHash: hash(projectId) });
	if (!(await read(folder))) return;
	await update(folder, () => ({ projectId }));
}
