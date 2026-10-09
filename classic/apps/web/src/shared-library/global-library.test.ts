import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	accountScope,
	registerAccount,
	sessionCookie,
} from "@/accounts/server";
import { globalAudioFile, globalLibraryRoot } from "./global-library";
import { GET as list, POST as mutate } from "@/app/api/shared-library/route";
import {
	GET as globalGet,
	HEAD as globalHead,
} from "@/app/api/global-assets/[...path]/route";
import { GET as oldGet } from "@/app/api/account-assets/[...path]/route";
import { GET as legacyGet } from "@/app/shared-library/[...path]/route";

test("global companion audio resolves unchanged IDs/bytes in every account, with license evidence and private uploads isolated", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-global-audio-"));
	const previous = process.env.OPENCUT_ACCOUNTS_DIR;
	process.env.OPENCUT_ACCOUNTS_DIR = root;
	try {
		const accounts = await Promise.all(
			["alice", "bob"].map((login) =>
				registerAccount({
					login,
					displayName: login,
					password: "global audio testing password",
				}),
			),
		);
		const asset = {
			id: "original-swish",
			name: "Swish",
			fileName: "original-swish.mp3",
			folder: "sfx",
			sourceUrl:
				"/api/global-assets/shared-library/audio/sfx/original-swish.mp3",
			license: { status: "needs-review" },
		};
		const library = globalLibraryRoot();
		await mkdir(join(library, "audio", "sfx"), { recursive: true });
		await writeFile(
			join(library, "manifest.json"),
			JSON.stringify({
				audioAssets: [
					asset,
					{
						...asset,
						id: "verified",
						fileName: "verified.mp3",
						license: {
							status: "commercial-use-verified",
							licenseId: "CC0-1.0",
							sourcePage: "https://kenney.nl/assets/interface-sounds",
						},
					},
				],
			}),
		);
		await writeFile(
			join(library, "audio", "sfx", asset.fileName),
			"original-swish-bytes",
		);
		const privateRoot = join(
			root,
			"data",
			accounts[0].account.id,
			"shared-library",
		);
		await mkdir(join(privateRoot, "audio", "sfx"), { recursive: true });
		await writeFile(
			join(privateRoot, "manifest.json"),
			JSON.stringify({
				audioAssets: [
					{ ...asset, name: "old private metadata" },
					{ ...asset, id: "private", fileName: "private.mp3" },
				],
			}),
		);
		await writeFile(
			join(privateRoot, "audio", "sfx", "private.mp3"),
			"private bytes",
		);
		const context = {
			params: Promise.resolve({
				path: ["shared-library", "audio", "sfx", asset.fileName],
			}),
		};
		for (const { account, token } of accounts) {
			// eslint-disable-next-line opencut/prefer-object-params -- Mirrors the Request URL/init transport signature.
			const request = (url: string, init: RequestInit = {}) =>
				new Request(`http://localhost:3000${url}`, {
					...init,
					headers: {
						cookie: sessionCookie(token),
						origin: "http://localhost:3000",
						...init.headers,
					},
				});
			const manifest = (
				await (await list(request("/api/shared-library"))).json()
			).manifest;
			expect(
				manifest.audioAssets.filter(
					(item: { id: string }) => item.id === asset.id,
				),
			).toHaveLength(1);
			expect(manifest.audioAssets[0]).toMatchObject({
				name: "Swish",
				visibility: "global",
				license: { status: "needs-review" },
			});
			expect(
				manifest.audioAssets.some(
					(item: { id: string }) => item.id === "private",
				),
			).toBe(account.id === accounts[0].account.id);
			expect(
				await (await globalGet(request(asset.sourceUrl), context)).text(),
			).toBe("original-swish-bytes");
			expect(
				await (
					await oldGet(
						request(
							"/api/account-assets/shared-library/audio/sfx/original-swish.mp3",
						),
						context,
					)
				).text(),
			).toBe("original-swish-bytes");
			expect(
				await (
					await legacyGet(
						request("/shared-library/audio/sfx/original-swish.mp3"),
						{
							params: Promise.resolve({
								path: ["audio", "sfx", asset.fileName],
							}),
						},
					)
				).text(),
			).toBe("original-swish-bytes");
			const range = await globalGet(
				request(asset.sourceUrl, { headers: { Range: "bytes=0-7" } }),
				context,
			);
			expect(range.status).toBe(206);
			expect(await range.text()).toBe("original");
			expect(
				(
					await globalHead(
						request(asset.sourceUrl, { method: "HEAD" }),
						context,
					)
				).headers.get("Content-Length"),
			).toBe("20");
			const denied = await mutate(
				request("/api/shared-library", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						action: "updateAudioAsset",
						assetId: asset.id,
						folder: "music",
					}),
				}),
			);
			expect(denied.status).toBe(403);
			const form = new FormData();
			form.set("action", "importAudio");
			form.set("metadata", JSON.stringify([{ id: asset.id, folder: "sfx" }]));
			form.append("files", new File(["replacement"], "replace.mp3"));
			expect(
				(
					await mutate(
						request("/api/shared-library", { method: "POST", body: form }),
					)
				).status,
			).toBe(409);
		}
		expect(
			(
				await globalGet(
					new Request("http://localhost:3000" + asset.sourceUrl),
					context,
				)
			).status,
		).toBe(401);
		expect(
			await globalAudioFile(["shared-library", "audio", "sfx", "private.mp3"]),
		).toBeNull();
		expect(
			await globalAudioFile(["shared-library", "audio", "..", "manifest.json"]),
		).toBeNull();
		await symlink(
			join(privateRoot, "audio", "sfx", "private.mp3"),
			join(library, "audio", "sfx", "verified.mp3"),
		);
		expect(
			await globalAudioFile(["shared-library", "audio", "sfx", "verified.mp3"]),
		).toBeNull();
		await accountScope.run(accounts[1].account, async () => {
			const response = await oldGet(
				new Request(
					"http://localhost:3000/api/account-assets/shared-library/audio/sfx/private.mp3",
					{ headers: { cookie: sessionCookie(accounts[1].token) } },
				),
				{
					params: Promise.resolve({
						path: ["shared-library", "audio", "sfx", "private.mp3"],
					}),
				},
			);
			expect(response.status).toBe(404);
		});
	} finally {
		if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});
