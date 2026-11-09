import { expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptMcpInstallation } from "../install-bundle";
import {
	activateMcpInstallation,
	authorizeMcpKey,
	issueMcpInstallation,
	mcpLocalOrigin,
	parseMcpCredential,
	revokeMcpInstallation,
} from "../server/delegation";

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");

test("MCP enrollment is single-use, account and project bound, rotated and revocable", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocut-mcp-test-"));
	const previous = process.env.OPENCUT_ACCOUNTS_DIR;
	process.env.OPENCUT_ACCOUNTS_DIR = root;
	const scope = { accountId: randomUUID(), projectId: randomUUID() };
	const freshKey = () =>
		parseMcpCredential(
			`pocut-key.${scope.accountId}.${hash(scope.projectId)}.${randomBytes(32).toString("base64url")}`,
			"key",
		)!;
	try {
		const setup = await issueMcpInstallation(scope);
		const credential = parseMcpCredential(setup.activation, "setup")!;
		const key = freshKey();
		expect(await authorizeMcpKey(key)).toBeNull();
		const race = await Promise.allSettled(
			[1, 2].map(() =>
				activateMcpInstallation({ credential, keyHash: hash(key.token) }),
			),
		);
		expect(race.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(await authorizeMcpKey(key)).toBe(scope.projectId);
		expect(
			await authorizeMcpKey({ ...key, accountId: randomUUID() }),
		).toBeNull();
		expect(
			await authorizeMcpKey({ ...key, projectHash: hash("other") }),
		).toBeNull();
		const record = await readFile(
			join(
				root,
				"data",
				scope.accountId,
				"editor-agent",
				"mcp",
				key.projectHash,
				"access.json",
			),
			"utf8",
		);
		expect(record).not.toContain(key.token);
		expect(record).not.toContain(setup.activation);
		const replacement = await issueMcpInstallation(scope);
		expect(await authorizeMcpKey(key)).toBe(scope.projectId);
		const next = freshKey();
		await activateMcpInstallation({
			credential: parseMcpCredential(replacement.activation, "setup")!,
			keyHash: hash(next.token),
		});
		expect(await authorizeMcpKey(key)).toBeNull();
		expect(await authorizeMcpKey(next)).toBe(scope.projectId);
		await revokeMcpInstallation(scope);
		expect(await authorizeMcpKey(next)).toBeNull();
	} finally {
		if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test("AES-GCM setup envelope separates the key and rejects a different code", async () => {
	const payload = {
		activation: "synthetic-secret",
		origin: "http://127.0.0.1:3000",
	};
	const { code, envelope } = await encryptMcpInstallation(payload);
	expect(JSON.stringify(envelope)).not.toContain(payload.activation);
	expect(JSON.stringify(envelope)).not.toContain(code);
	const decrypt = async (raw: Uint8Array<ArrayBuffer>) =>
		crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: new Uint8Array(Buffer.from(envelope.iv, "base64url")),
			},
			await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]),
			new Uint8Array(Buffer.from(envelope.encrypted, "base64url")),
		);
	expect(
		JSON.parse(
			new TextDecoder().decode(
				await decrypt(new Uint8Array(Buffer.from(code, "base64url"))),
			),
		),
	).toEqual(payload);
	await expect(decrypt(new Uint8Array(32))).rejects.toThrow();
});

test("local MCP is disabled by default and when the host is public", () => {
	const enabled = process.env.OPENCUT_DELEGATED_MCP_LOCAL;
	const publicOrigin = process.env.OPENCUT_PUBLIC_ORIGIN;
	try {
		delete process.env.OPENCUT_DELEGATED_MCP_LOCAL;
		expect(() =>
			mcpLocalOrigin(new Request("http://127.0.0.1:3000")),
		).toThrow();
		process.env.OPENCUT_DELEGATED_MCP_LOCAL = "1";
		delete process.env.OPENCUT_PUBLIC_ORIGIN;
		expect(mcpLocalOrigin(new Request("http://127.0.0.1:3000"))).toBe(
			"http://127.0.0.1:3000",
		);
		expect(() =>
			mcpLocalOrigin(new Request("https://pocut.example")),
		).toThrow();
		process.env.OPENCUT_PUBLIC_ORIGIN = "https://pocut.example";
		expect(() =>
			mcpLocalOrigin(new Request("http://127.0.0.1:3000")),
		).toThrow();
	} finally {
		if (enabled === undefined) delete process.env.OPENCUT_DELEGATED_MCP_LOCAL;
		else process.env.OPENCUT_DELEGATED_MCP_LOCAL = enabled;
		if (publicOrigin === undefined) delete process.env.OPENCUT_PUBLIC_ORIGIN;
		else process.env.OPENCUT_PUBLIC_ORIGIN = publicOrigin;
	}
});
