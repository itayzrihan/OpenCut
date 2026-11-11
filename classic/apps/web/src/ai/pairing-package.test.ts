import { expect, test } from "bun:test";
import { readZipEntries } from "@/project/archive/zip";
import { createPairingPackage } from "./pairing-package";

test("the assistant ZIP contains verified setup files and no account credentials", async () => {
	const fetchOriginal = globalThis.fetch;
	const script = "console.log('test companion');";
	const bytes = new TextEncoder().encode(script);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const sha256 = Buffer.from(digest).toString("hex");
	const setup = {
		version: 1 as const,
		origin: "https://editor.example.com",
		setupId: crypto.randomUUID(),
		expiresAt: Date.now() + 60_000,
	};
	let expectedDigest = sha256;
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
		if (input === "/downloads/pocut-companion-v4.mjs")
			return new Response(script);
		expect(input).toBe("/downloads/pocut-companion-v4.json");
		return Response.json({
			version: 4,
			filename: "pocut-companion-v4.mjs",
			sha256: expectedDigest,
			bytes: bytes.length,
		});
	}, fetchOriginal);
	try {
		const signal = new AbortController().signal;
		const blob = await createPairingPackage({ setup, signal });
		const entries = await readZipEntries({ blob });
		expect([...entries.keys()]).toEqual([
			"README.md",
			"POCUT-Setup.json",
			"pocut-companion.mjs",
		]);
		expect(await entries.get("POCUT-Setup.json")?.json()).toEqual(setup);
		expect(await entries.get("pocut-companion.mjs")?.text()).toBe(script);
		const instructions = await entries.get("README.md")?.text();
		expect(instructions).toContain("Continue with ChatGPT");
		expect(instructions).toContain("**POCUT Companion** desktop shortcut");
		expect(instructions).toContain("start automatically when you sign in");
		expect(instructions).toContain("**Connect**");
		expect(instructions).toContain("**Allow**");
		expect(instructions).toContain("POCUT-Setup.json --install");
		expect(instructions).toContain("POCUT-Setup.json --login-claude");
		const withToken = { ...setup, token: "a".repeat(64) };
		await expect(
			createPairingPackage({ setup: withToken, signal }),
		).rejects.toThrow();
		expectedDigest = "b".repeat(64);
		await expect(createPairingPackage({ setup, signal })).rejects.toThrow(
			"could not be verified",
		);
	} finally {
		globalThis.fetch = fetchOriginal;
	}
});
