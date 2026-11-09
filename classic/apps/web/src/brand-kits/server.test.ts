// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAccount, sessionCookie, withAccount } from "@/accounts/server";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { brandKitTransaction } from "./server";
import { newBrandKit, type BrandKitLibrary } from "./types";

test("canonical Brand Kits persist, retry after reopen, reject stale writes, and isolate authenticated accounts", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-brand-kits-"));
	const previous = process.env.OPENCUT_ACCOUNTS_DIR;
	process.env.OPENCUT_ACCOUNTS_DIR = root;
	try {
		const alice = await registerAccount({
			login: "brand-alice",
			displayName: "Alice",
			password: "brand kit test password one",
		});
		const bob = await registerAccount({
			login: "brand-bob",
			displayName: "Bob",
			password: "brand kit test password two",
		});
		const handler = withAccount(async (request: Request) => {
			try {
				const body =
					request.method === "POST" ? await request.json() : undefined;
				return Response.json(
					await brandKitTransaction({
						factory: createCanonicalTestRuntime,
						...(body ? { edit: body } : {}),
					}),
				);
			} catch (error) {
				return Response.json({ error: String(error) }, { status: 409 });
			}
		});
		const request = ({ token, edit }: { token: string; edit?: unknown }) =>
			handler(
				new Request("http://localhost:3211/api/brand-kits", {
					method: edit ? "POST" : "GET",
					headers: {
						origin: "http://localhost:3211",
						cookie: sessionCookie(token),
						"Content-Type": "application/json",
					},
					...(edit ? { body: JSON.stringify(edit) } : {}),
				}),
			);
		const original = (await (
			await request({ token: alice.token })
		).json()) as BrandKitLibrary;
		expect(original.kits).toEqual([]);
		const images = [
			{
				assetId: "portrait",
				kind: "character" as const,
				name: "Studio host",
				tags: ["presenter", "portrait"],
			},
		];
		const stickerManifest = join(
			root,
			"data",
			alice.account.id,
			"shared-library",
		);
		await mkdir(stickerManifest, { recursive: true });
		await writeFile(
			join(stickerManifest, "manifest.json"),
			JSON.stringify({
				stickerAssets: [
					{
						id: "portrait",
						storageKind: "account",
						mimeType: "image/png",
						width: 120,
						height: 160,
					},
				],
			}),
		);
		const kit = { ...newBrandKit(), name: "Alice Brand", images };
		const edit = {
			expectedRevision: original.revision,
			requestId: "first-write",
			change: { type: "upsert", kit },
		};
		const savedResponse = await request({ token: alice.token, edit: edit });
		expect(savedResponse.status).toBe(200);
		const saved = (await savedResponse.json()) as BrandKitLibrary;
		expect(saved.kits).toEqual([kit]);
		const bobLibrary = (await (
			await request({ token: bob.token })
		).json()) as BrandKitLibrary;
		const foreign = await request({
			token: bob.token,
			edit: { ...edit, expectedRevision: bobLibrary.revision },
		});
		expect(foreign.status).toBe(409);
		expect((await foreign.json()).error).toContain(
			"does not belong to this account",
		);
		expect(
			await (await request({ token: alice.token, edit: edit })).json(),
		).toEqual(saved);
		expect(
			(
				await request({
					token: alice.token,
					edit: {
						...edit,
						change: { type: "upsert", kit: { ...kit, name: "Forged retry" } },
					},
				})
			).status,
		).toBe(409);
		expect(
			(
				await request({
					token: alice.token,
					edit: {
						...edit,
						requestId: "stale",
						change: { type: "upsert", kit: { ...kit, name: "Old tab" } },
					},
				})
			).status,
		).toBe(409);
		expect((await (await request({ token: bob.token })).json()).kits).toEqual(
			[],
		);
		const results = await Promise.all(
			["tab-one", "tab-two"].map((id) =>
				request({
					token: alice.token,
					edit: {
						expectedRevision: saved.revision,
						requestId: id,
						change: { type: "upsert", kit: { ...newBrandKit(), name: id } },
					},
				}),
			),
		);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		const reopened = (await (
			await request({ token: alice.token })
		).json()) as BrandKitLibrary;
		expect(reopened.kits).toHaveLength(2);
		const removed = await request({
			token: alice.token,
			edit: {
				expectedRevision: reopened.revision,
				requestId: "remove-kit",
				change: { type: "remove", kitId: kit.id },
			},
		});
		expect(removed.status).toBe(200);
		expect((await removed.json()).kits).toHaveLength(1);
		expect((await (await request({ token: bob.token })).json()).kits).toEqual(
			[],
		);
	} finally {
		if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}, 30000);
