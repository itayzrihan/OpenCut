import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountScope, registerAccount, accountDataRoot } from "./server";
import { recoverMissingLegacyAssets } from "./migration";
test("missing legacy assets recover independently without exposing another account or replacing projects", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-assets-"));
	const before = process.env.OPENCUT_ACCOUNTS_DIR;
	process.env.OPENCUT_ACCOUNTS_DIR = join(root, "accounts");
	try {
		const owner = await registerAccount({
			login: "owner",
			displayName: "Owner",
			password: "strong migration password",
		});
		const other = await registerAccount({
			login: "other",
			displayName: "Other",
			password: "strong migration password",
		});
		const publicRoot = join(root, "old-public");
		await mkdir(join(publicRoot, "shared-library", "audio"), {
			recursive: true,
		});
		await writeFile(
			join(publicRoot, "shared-library", "audio", "swish.mp3"),
			"original audio",
		);
		await writeFile(
			join(publicRoot, "shared-library", "manifest.json"),
			JSON.stringify({
				audioAssets: [{ sourceUrl: "/shared-library/audio/swish.mp3" }],
			}),
		);
		await expect(
			accountScope.run(other.account, () =>
				recoverMissingLegacyAssets({ publicRoot }),
			),
		).rejects.toThrow("first account");
		await accountScope.run(owner.account, async () => {
			const target = accountDataRoot();
			await mkdir(join(target, "projects"), { recursive: true });
			await writeFile(
				join(target, "projects", "keep.json"),
				"unchanged project",
			);
			expect(await recoverMissingLegacyAssets({ publicRoot })).toEqual({
				recovered: ["shared-library"],
			});
			expect(
				await readFile(join(target, "projects", "keep.json"), "utf8"),
			).toBe("unchanged project");
			expect(
				await readFile(
					join(target, "shared-library", "audio", "swish.mp3"),
					"utf8",
				),
			).toBe("original audio");
			expect(
				JSON.parse(
					await readFile(
						join(target, "shared-library", "manifest.json"),
						"utf8",
					),
				).audioAssets[0].sourceUrl,
			).toBe("/api/account-assets/shared-library/audio/swish.mp3");
			await writeFile(
				join(publicRoot, "shared-library", "audio", "swish.mp3"),
				"different",
			);
			expect(await recoverMissingLegacyAssets({ publicRoot })).toEqual({
				recovered: [],
			});
			expect(
				await readFile(
					join(target, "shared-library", "audio", "swish.mp3"),
					"utf8",
				),
			).toBe("original audio");
		});
	} finally {
		if (before === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = before;
		await rm(root, { recursive: true, force: true });
	}
});
