import { expect, mock, test } from "bun:test";
mock.module("@/services/local-drive/adapters", () => ({
	LocalDriveJsonAdapter: class {
		async getAll() {
			return [];
		}
	},
	LocalDriveFileAdapter: class {},
}));
mock.module("@/services/storage/service", () => ({ storageService: {} }));
mock.module("@/subtitles/caption-layout", () => ({
	normalizeCaptionLayoutSettings: (v: unknown) => v,
}));
const { sharedLibraryService } = await import("./service");
test("repeated audio playback resolves one private URL per account", async () => {
	const originalFetch = globalThis.fetch;
	const previousWindow = globalThis.window;
	let count = 0;
	const scope = {
		__opencutAccountId: "first",
		location: { origin: "http://localhost" },
	};
	Object.assign(globalThis, { window: scope });
	globalThis.fetch = mock(async () => {
		count++;
		return Response.json({
			manifest: {
				audioAssets: [
					{
						id: "swish",
						sourceUrl: "/api/account-assets/swish.mp3",
						createdAt: "2026-01-01",
					},
				],
			},
		});
	}) as unknown as typeof fetch;
	try {
		const urls = await Promise.all(
			Array.from({ length: 50 }, () =>
				sharedLibraryService.getAudioAssetUrl({ id: "swish" }),
			),
		);
		expect(count).toBe(1);
		expect(new Set(urls)).toEqual(
			new Set(["/api/account-assets/swish.mp3?account=first"]),
		);
		await sharedLibraryService.getAudioAssetUrl({ id: "swish" });
		expect(count).toBe(1);
		scope.__opencutAccountId = "second";
		expect(await sharedLibraryService.getAudioAssetUrl({ id: "swish" })).toBe(
			"/api/account-assets/swish.mp3?account=second",
		);
		expect(count).toBe(2);
	} finally {
		globalThis.fetch = originalFetch;
		Object.assign(globalThis, { window: previousWindow });
	}
});

test("global files bypass private stored bytes and concurrent catalog reads share one request", async () => {
	const { SharedLibraryService } = await import("./service");
	const service = new SharedLibraryService();
	const originalFetch = globalThis.fetch;
	const previousWindow = globalThis.window;
	Object.assign(globalThis, {
		window: {
			__opencutAccountId: "viewer",
			location: { origin: "http://localhost" },
		},
	});
	let catalogReads = 0;
	const downloads: string[] = [];
	const asset = {
		id: "global-swish",
		visibility: "global",
		sourceUrl: "/api/global-assets/shared-library/audio/sfx/swish.mp3",
		name: "Swish",
		mimeType: "audio/mpeg",
		updatedAt: "2026-01-01",
		createdAt: "2026-01-01",
	};
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL) => {
			if (String(input) === "/api/shared-library") {
				catalogReads++;
				return Response.json({ manifest: { audioAssets: [asset] } });
			}
			downloads.push(String(input));
			return new Response("global bytes", {
				headers: { "Content-Type": "audio/mpeg" },
			});
		},
		{ preconnect: originalFetch.preconnect },
	);
	try {
		await Promise.all([
			service.listAudioAssets(),
			service.listStickerAssets(),
			service.listCategories(),
		]);
		expect(catalogReads).toBe(1);
		// The mock private file adapter deliberately has no get(): global playback
		// must never inspect an account file with the same published asset ID.
		const file = await service.getAudioAssetFile({ id: asset.id });
		expect(await file?.text()).toBe("global bytes");
		expect(downloads).toEqual([asset.sourceUrl + "?account=viewer"]);
	} finally {
		globalThis.fetch = originalFetch;
		Object.assign(globalThis, { window: previousWindow });
	}
});
