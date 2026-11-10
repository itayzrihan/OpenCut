import { expect, mock, test } from "bun:test";
const audioFile = new File(["audio"], "music.mp3", { type: "audio/mpeg" });
const stickerFile = new File(["sticker"], "sticker.png", { type: "image/png" });
const sourceAudio = {
	id: "source-audio",
	name: "Music",
	mimeType: "audio/mpeg",
	size: audioFile.size,
	folder: "music",
	createdAt: "2026-01-01",
	updatedAt: "2026-01-01",
	sourceUrl: "https://trusted-library.example/music",
	repositoryPath: "/private/library/music",
	visibility: "global",
};
const sourceSticker = {
	id: "source-sticker",
	name: "Sticker",
	mimeType: "image/png",
	size: stickerFile.size,
	dataUrl: "data:old",
	sourceUrl: "https://trusted-library.example/sticker",
	createdAt: "2026-01-01",
	updatedAt: "2026-01-01",
};
const loaded: string[] = [];
mock.module("@/shared-library/service", () => ({
	sharedLibraryService: {
		listAudioAssets: async () => [sourceAudio],
		listStickerAssets: async () => [sourceSticker],
		getAudioAssetFile: async ({ id }: { id: string }) => {
			loaded.push(id);
			return audioFile;
		},
		getStickerAssetFile: async ({ id }: { id: string }) => {
			loaded.push(id);
			return stickerFile;
		},
	},
}));
const stored: Array<{
	accountId: string;
	database: string;
	key: string;
	value: Record<string, unknown>;
}> = [];
mock.module("@/services/storage/indexeddb-adapter", () => ({
	IndexedDBAdapter: class {
		constructor(private options: { accountId: string; dbName: string }) {}
		async set({ key, value }: { key: string; value: Record<string, unknown> }) {
			stored.push({
				accountId: this.options.accountId,
				database: this.options.dbName,
				key,
				value,
			});
		}
	},
}));
const remoteWrites: Array<unknown> = [];
mock.module("@/services/local-drive/client", () => ({
	localDriveRequest: async (input: unknown) => {
		remoteWrites.push(input);
		return {};
	},
}));
const { collectSharedExchangeAssets, importSharedExchangeAsset } =
	await import("./shared-assets");

function environment() {
	const previous = {
		window: globalThis.window,
		navigator: globalThis.navigator,
		fetch: globalThis.fetch,
	};
	const scope = { __opencutAccountId: "owner", __opencutHostedLegitate: true };
	const files: Array<{ directory: string; id: string; file: Blob }> = [];
	let onWrite = () => {};
	Object.assign(globalThis, {
		window: scope,
		navigator: {
			storage: {
				getDirectory: async () => ({
					getDirectoryHandle: async (directory: string) => ({
						getFileHandle: async (id: string) => ({
							createWritable: async () => ({
								write: async (file: Blob) => {
									files.push({ directory, id, file });
									onWrite();
								},
								close: async () => {},
								abort: async () => {},
							}),
						}),
					}),
				}),
			},
		},
	});
	stored.length = 0;
	remoteWrites.length = 0;
	loaded.length = 0;
	return {
		scope,
		files,
		onWrite: (callback: () => void) => {
			onWrite = callback;
		},
		restore: () => Object.assign(globalThis, previous),
	};
}

test("collects current and historical shared references once, retaining metadata but no import locators", async () => {
	const env = environment();
	try {
		const audio = {
			type: "audio",
			sourceType: "library",
			librarySourceType: "shared",
			libraryAssetId: sourceAudio.id,
		};
		const sticker = {
			type: "sticker",
			stickerId: "user-stickers:" + sourceSticker.id,
		};
		const assets = await collectSharedExchangeAssets([
			{ scenes: [{ tracks: { main: { elements: [audio] } } }] },
			{ undone: [audio, sticker] },
			{
				type: "audio",
				sourceType: "library",
				librarySourceType: "url",
				libraryAssetId: "unrelated",
			},
		]);
		expect(assets.map((asset) => asset.id).sort()).toEqual([
			sourceAudio.id,
			sourceSticker.id,
		]);
		for (const asset of assets) {
			for (const key of [
				"sourceUrl",
				"repositoryPath",
				"dataUrl",
				"visibility",
			])
				expect(asset.metadata[key]).toBeUndefined();
			expect(await asset.getFile()).not.toBeNull();
		}
		expect(loaded.sort()).toEqual([sourceAudio.id, sourceSticker.id]);
		env.scope.__opencutAccountId = "other";
		await expect(assets[0]!.getFile()).rejects.toThrow("Account changed");
	} finally {
		env.restore();
	}
});

test("shared imports allocate fresh account-owned IDs and use selected bytes only", async () => {
	const env = environment();
	try {
		const first = await importSharedExchangeAsset({
			kind: "sharedAudio",
			metadata: sourceAudio,
			file: audioFile,
		});
		const second = await importSharedExchangeAsset({
			kind: "sharedAudio",
			metadata: sourceAudio,
			file: audioFile,
		});
		expect(new Set([first, second, sourceAudio.id]).size).toBe(3);
		const sticker = await importSharedExchangeAsset({
			kind: "sharedSticker",
			metadata: sourceSticker,
			file: stickerFile,
		});
		expect(env.files).toHaveLength(3);
		for (const item of stored) {
			expect(item.accountId).toBe("owner");
			expect(item.value.visibility).toBe("account");
			expect(item.value.sourceUrl).toBeUndefined();
			expect(item.value.repositoryPath).toBeUndefined();
		}
		expect(stored.find((item) => item.key === sticker)?.value.dataUrl).toBe(
			"data:image/png;base64," + btoa("sticker"),
		);
		await expect(
			importSharedExchangeAsset({
				kind: "sharedAudio",
				metadata: { ...sourceAudio, sha256: "0".repeat(64) },
				file: audioFile,
			}),
		).rejects.toThrow("checksum");
		expect(stored).toHaveLength(3);
	} finally {
		env.restore();
	}
});

test("metadata-only import remains missing and account switching cannot redirect writes", async () => {
	const env = environment();
	try {
		await importSharedExchangeAsset({
			kind: "sharedSticker",
			metadata: sourceSticker,
			file: null,
		});
		expect(env.files).toHaveLength(0);
		expect(stored[0]!.value.dataUrl).toBeUndefined();
		env.onWrite(() => {
			env.scope.__opencutAccountId = "other";
		});
		await expect(
			importSharedExchangeAsset({
				kind: "sharedAudio",
				metadata: sourceAudio,
				file: audioFile,
			}),
		).rejects.toThrow("Account changed");
		expect(env.files[0]!.directory).toBe(
			"opencut-account-owner-hosted-shared-files-audio",
		);
		expect(stored).toHaveLength(1);
	} finally {
		env.restore();
	}
});

test("desktop metadata import uses an explicitly pinned existing shared storage request", async () => {
	const env = environment();
	try {
		env.scope.__opencutHostedLegitate = false;
		const id = await importSharedExchangeAsset({
			kind: "sharedAudio",
			metadata: sourceAudio,
			file: null,
		});
		expect(remoteWrites).toEqual([
			{
				operation: "shared.put",
				payload: {
					collection: "audio",
					id,
					value: expect.objectContaining({
						id,
						storageKind: "account",
						visibility: "account",
					}),
				},
				scope: { accountId: "owner", signal: undefined },
			},
		]);
		expect(stored).toHaveLength(0);
	} finally {
		env.restore();
	}
});
