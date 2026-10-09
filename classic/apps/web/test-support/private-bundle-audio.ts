import { expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	accountScope,
	registerAccount,
	sessionCookie,
} from "@/accounts/server";
import { importLegacyAccount } from "@/accounts/migration";
import { GET as readLibrary } from "@/app/api/shared-library/route";
import { GET as readAsset } from "@/app/api/account-assets/[...path]/route";
import type { SharedLibraryManifest } from "@/shared-library/types";

// These presets refer to the owner's library, removed from public/ when local
// accounts were introduced. Use synthetic bytes to test the migration and real
// authenticated routes without requiring or publishing the owner's audio.
export async function expectMigratedBundleAudio(assetIds: string[]) {
	const root = await mkdtemp(join(tmpdir(), "opencut-bundle-audio-"));
	const keys = [
		"OPENCUT_ACCOUNTS_DIR",
		"POCUT_PROJECTS_DIR",
		"OPENCUT_LEGACY_PUBLIC_DIR",
	] as const;
	const previous = keys.map((key) => process.env[key]);
	keys.forEach((key, index) => {
		process.env[key] = join(root, String(index));
	});
	try {
		const libraryRoot = join(
			process.env.OPENCUT_LEGACY_PUBLIC_DIR!,
			"shared-library",
		);
		await mkdir(join(libraryRoot, "audio", "sfx"), { recursive: true });
		const bytes = new Map(
			assetIds.map((id) => [id, Buffer.from(`private test audio ${id}`)]),
		);
		const manifest: SharedLibraryManifest = {
			version: 1,
			audioAssets: assetIds.map((id, index) => ({
				id,
				name: `Renamed sound ${index}`,
				folder: "sfx",
				mimeType: "audio/mpeg",
				size: bytes.get(id)!.length,
				storageKind: "repo",
				fileName: `${id}.mp3`,
				sourceUrl: `/shared-library/audio/sfx/${id}.mp3`,
				repositoryPath: `public/shared-library/audio/sfx/${id}.mp3`,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			})),
			stickerAssets: [],
			categories: [],
			generatedBackgrounds: [],
			generatedEffects: [],
			generatedUiElements: [],
			captionPresets: [],
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		const original = JSON.stringify(manifest);
		await writeFile(join(libraryRoot, "manifest.json"), original);
		for (const [id, content] of bytes)
			await writeFile(join(libraryRoot, "audio", "sfx", `${id}.mp3`), content);
		const owner = await registerAccount({ login: "owner", displayName: "Owner", password: "bundle test owner password" }
		);
		const other = await registerAccount({ login: "other", displayName: "Other", password: "bundle test other password" }
		);
		await accountScope.run(owner.account, () => importLegacyAccount({  }));
		const request = (url: string, token?: string) =>
			new Request(`http://localhost:3000${url}`, {
				headers: token ? { cookie: sessionCookie(token) } : {},
			});
		const response = await readLibrary(
			request("/api/shared-library", owner.token),
		);
		expect(response.status).toBe(200);
		const { manifest: migrated } = (await response.json()) as {
			manifest: SharedLibraryManifest;
		};
		expect(migrated.audioAssets.map((asset) => asset.id)).toEqual(assetIds);
		for (const asset of migrated.audioAssets) {
			const sourceUrl = `/api/account-assets/shared-library/audio/sfx/${asset.id}.mp3`;
			expect(asset.sourceUrl).toBe(sourceUrl);
			expect(asset.name).toBe(
				manifest.audioAssets.find((item) => item.id === asset.id)!.name,
			);
			const context = {
				params: Promise.resolve({
					path: ["shared-library", "audio", "sfx", `${asset.id}.mp3`],
				}),
			};
			const audio = await readAsset(request(sourceUrl, owner.token), context);
			expect(audio.status).toBe(200);
			expect(audio.headers.get("content-type")).toBe("audio/mpeg");
			expect(Buffer.from(await audio.arrayBuffer())).toEqual(
				bytes.get(asset.id)!,
			);
			expect(
				(await readAsset(request(sourceUrl, other.token), context)).status,
			).toBe(404);
			expect((await readAsset(request(sourceUrl), context)).status).toBe(401);
			expect(
				await readFile(join(libraryRoot, "audio", "sfx", `${asset.id}.mp3`)),
			).toEqual(bytes.get(asset.id)!);
		}
		const otherResponse = await readLibrary(
			request("/api/shared-library", other.token),
		);
		expect(otherResponse.status).toBe(200);
		expect((await otherResponse.json()).manifest.audioAssets).toEqual([]);
		expect(await readFile(join(libraryRoot, "manifest.json"), "utf8")).toBe(
			original,
		);
	} finally {
		keys.forEach((key, index) => {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		});
		await rm(root, { recursive: true, force: true });
	}
}
