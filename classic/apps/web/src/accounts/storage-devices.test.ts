import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountScope, registerAccount } from "./server";
import {
	listStorageDevices,
	localStorageDevice,
	publishStorageDevice,
} from "./storage-devices";
import { seal, unseal } from "./vault-crypto";

test("device identities survive concurrent reads, encrypt names, and reject forged or cross-account discovery", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-devices-")),
		previous = process.env.OPENCUT_ACCOUNTS_DIR;
	process.env.OPENCUT_ACCOUNTS_DIR = join(root, "host");
	try {
		const { account } = await registerAccount({ login: "device-owner", displayName: "Device Owner", password: "device verification test password" }
		);
		const vault = join(root, "vault"),
			key = randomBytes(32);
		await accountScope.run(account, async () => {
			const devices = await Promise.all(
				Array.from({ length: 8 }, () =>
					localStorageDevice({ existingId: undefined, name: "Private machine name" }),
				),
			);
			expect(new Set(devices.map((device) => device.id)).size).toBe(1);
			expect(new Set(devices.map((device) => device.fingerprint)).size).toBe(1);
			const device = devices[0];
			await publishStorageDevice({ root: vault, key: key, device: device });
			expect((await listStorageDevices({ root: vault, key: key }))[0]).toEqual(device);
			const path = join(vault, "devices", `${device.id}.device`),
				bytes = await readFile(path);
			expect(bytes.includes(Buffer.from(device.name))).toBe(false);
			await accountScope.run(
				{ ...account, id: "different-account" },
				async () => {
					await expect(listStorageDevices({ root: vault, key: key })).rejects.toThrow();
				},
			);
			const aad = `${account.id}:device:${device.id}`,
				forged = JSON.parse(unseal({ data: bytes, key: key, aad: aad }).toString("utf8"));
			forged.name = "Forged machine name";
			await writeFile(
				path,
				seal({ data: Buffer.from(JSON.stringify(forged)), key: key, aad: aad }),
			);
			await expect(listStorageDevices({ root: vault, key: key })).rejects.toThrow(
				"verification failed",
			);
		});
	} finally {
		if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});
