/** Authenticated filesystem adapter. All branding state/validation/history lives in OpenCutRuntime. */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { accountDataRoot, requireAccount } from "@/accounts/server";
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import type { SharedStickerAsset } from "@/shared-library/types";
import {
	BRAND_IMAGE_MIME_TYPES,
	type BrandKit,
	type BrandKitLibrary,
} from "./types";

const host = globalThis as typeof globalThis & {
	__brandKitQueues?: Map<string, Promise<unknown>>;
};
const queues = (host.__brandKitQueues ??= new Map());
export type BrandRuntimeFactory = () => Promise<CanonicalEditorRuntime>;
const createRuntime: BrandRuntimeFactory = async () =>
	new (await import("opencut-editor-runtime-wasm")).CanonicalEditorRuntime();

async function assertNewImagesOwned({
	kit,
	previous,
}: {
	kit: BrandKit;
	previous?: BrandKit;
}) {
	const previousIds = new Set(previous?.images?.map((image) => image.assetId));
	const newImages = kit.images?.filter(
		(image) => !previousIds.has(image.assetId),
	);
	if (!newImages?.length) return;
	const manifest = await readFile(
		join(accountDataRoot(), "shared-library", "manifest.json"),
		"utf8",
	)
		.then(
			(value) => JSON.parse(value) as { stickerAssets?: SharedStickerAsset[] },
		)
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return { stickerAssets: [] };
		});
	const available = new Set(
		manifest.stickerAssets
			?.filter(
				(asset) =>
					asset.storageKind === "account" &&
					BRAND_IMAGE_MIME_TYPES.includes(asset.mimeType) &&
					!!asset.width &&
					!!asset.height,
			)
			.map((asset) => asset.id),
	);
	if (newImages.some((image) => !available.has(image.assetId)))
		throw new Error(
			"A Brand Kit image does not belong to this account or is unavailable",
		);
}

export async function brandKitTransaction({
	edit,
	factory = createRuntime,
}: {
	edit?: { expectedRevision: number; requestId: string; change: unknown };
	factory?: BrandRuntimeFactory;
} = {}): Promise<BrandKitLibrary> {
	const account = requireAccount();
	const root = join(accountDataRoot(), "brand-kits");
	const pending = (queues.get(root) ?? Promise.resolve())
		.catch(() => {})
		.then(async () => {
			await mkdir(root, { recursive: true, mode: 0o700 });
			let compromised = false;
			const release = await lockfile.lock(root, {
				realpath: false,
				stale: 60000,
				update: 10000,
				retries: { retries: 40, minTimeout: 25, maxTimeout: 250 },
				onCompromised: () => {
					compromised = true;
				},
			});
			let runtime: CanonicalEditorRuntime | undefined;
			try {
				runtime = await factory();
				const path = join(root, "library.json");
				try {
					runtime.restore(new Uint8Array(await readFile(path)));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					runtime.invokeSync(
						"app.state.patch",
						{
							patch: [
								{
									op: "add",
									path: "/account",
									value: {
										id: account.id,
										displayName: account.displayName,
										storage: {
											mode: "localOnly",
											destinationId: null,
											devices: [],
										},
										brandKits: [],
									},
								},
							],
						},
						null,
					);
				}
				const snapshot = runtime.snapshot() as {
					revision: number;
					account: { id: string; brandKits: BrandKitLibrary["kits"] };
				};
				if (snapshot.account.id !== account.id)
					throw new Error("Brand Kit account mismatch");
				if (edit) {
					if (!edit.requestId || edit.requestId.length > 128)
						throw new Error("A bounded request identity is required");
					// Persisted retry identity survives server restarts and distinguishes lost responses.
					const state = runtime.snapshot() as {
						extensions?: { brandKitReceipt?: { id: string; input: string } };
					};
					const original = JSON.stringify({
						expectedRevision: edit.expectedRevision,
						change: edit.change,
					});
					const receipt = state.extensions?.brandKitReceipt;
					if (receipt?.id === edit.requestId) {
						if (receipt.input !== original)
							throw new Error(
								"Brand Kit request identity was reused with different data",
							);
					} else {
						const change = edit.change as {
							type?: string;
							kitId?: string;
							kit?: { id: string };
						};
						runtime.invokeSync(
							change?.type === "remove"
								? "account.brand_kits.remove"
								: "account.brand_kits.edit",
							{
								accountId: account.id,
								expectedRevision: edit.expectedRevision,
								...(change?.type === "remove"
									? { kitId: change.kitId }
									: { change }),
							},
							{ requestId: edit.requestId },
						);
						if (change?.type === "upsert") {
							const next = runtime.snapshot() as typeof snapshot;
							const kit = next.account.brandKits.find(
								(value) => value.id === change.kit?.id,
							);
							if (kit)
								await assertNewImagesOwned({
									kit,
									previous: snapshot.account.brandKits.find(
										(value) => value.id === kit.id,
									),
								});
						}
						runtime.invokeSync(
							"app.state.patch",
							{
								patch: [
									{
										op: "add",
										path: "/extensions/brandKitReceipt",
										value: { id: edit.requestId, input: original },
									},
								],
							},
							null,
						);
						if (compromised) throw new Error("Brand Kit lock was lost");
						const temp = join(root, `${randomUUID()}.tmp`);
						try {
							const file = await open(temp, "wx", 0o600);
							try {
								await file.writeFile(runtime.serializeWithHistory());
								await file.sync();
							} finally {
								await file.close();
							}
							if (compromised) throw new Error("Brand Kit lock was lost");
							await rename(temp, path);
						} finally {
							await unlink(temp).catch(() => {});
						}
					}
				}
				const value = (
					runtime.invokeSync(
						"app.state.read",
						{ pointer: "/account" },
						null,
					) as {
						result: { data: { value: { brandKits: BrandKitLibrary["kits"] } } };
					}
				).result.data.value;
				return {
					accountId: account.id,
					revision: (runtime.snapshot() as { revision: number }).revision,
					kits: value.brandKits ?? [],
				};
			} finally {
				runtime?.free();
				await release();
			}
		});
	queues.set(root, pending);
	try {
		return await pending;
	} finally {
		if (queues.get(root) === pending) queues.delete(root);
	}
}
