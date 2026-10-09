import { expect, mock, spyOn, test } from "bun:test";
import { EditorSessionClient, EditorSessionFailure } from "../session-client";
import { editorWriteHeaders } from "../write-authority";
// This test exercises actual font storage transport, not timeline math.
const unexpectedMath = () => {
	throw new Error("Unexpected timeline math in font transport");
};
mock.module("@/wasm", () => ({ roundMediaTime: unexpectedMath }));
mock.module("@/timeline/scenes", () => ({
	getProjectDurationFromScenes: unexpectedMath,
}));
const { StorageService } = await import("@/services/storage/service");

const scope = { accountId: "alice", projectId: "film" };
const granted = ({
	sessionId,
	generation,
}: {
	sessionId: string;
	generation: number;
}) => ({
	storageRevision: 0,
	generation,
	lease: { sessionId, generation, expiresAtMs: Date.now() + 90_000 },
	saved: null,
	legacyProject: null,
	legacyHistory: null,
});

for (const kind of ["font", "media"] as const)
	test(`the complete ${kind}-save workflow keeps its initiating generation across takeover`, async () => {
		const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { __opencutAccountId: "alice" },
		});
		const old = new EditorSessionClient({
			...scope,
			sessionId: "old",
			exchange: async () => granted({ sessionId: "old", generation: 1 }),
		});
		const current = new EditorSessionClient({
			...scope,
			sessionId: "current",
			exchange: async () => granted({ sessionId: "current", generation: 2 }),
		});
		await old.acquire({ expectedGeneration: 0 });
		const calls: Headers[] = [];
		const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
			// eslint-disable-next-line opencut/prefer-object-params -- Native fetch signature.
			(async (_url: RequestInfo | URL, options?: RequestInit) => {
				calls.push(new Headers(options?.headers));
				if (calls.length === 1) {
					await current.acquire({ expectedGeneration: 1, takeOver: true });
					old.dispose();
					return Response.json({ storedPath: "fonts/files/original.woff2" });
				}
				// Simulate the host rejecting publication from the old generation.
				return Response.json(
					{ error: "Editor ownership transferred" },
					{ status: 409 },
				);
			}) as typeof fetch,
		);
		try {
			const file = new File(["font"], "font.woff2", { type: "font/woff2" });
			const storage = new StorageService();
			await expect(
				kind === "media"
					? storage.saveMediaAsset({
							projectId: scope.projectId,
							mediaAsset: {
								id: "asset",
								name: "image.png",
								type: "image",
								file,
							},
						})
					: storage.saveProjectFont({
							projectId: scope.projectId,
							font: {
								id: "font",
								family: "Example",
								fileName: file.name,
								mimeType: file.type,
								size: file.size,
								lastModified: file.lastModified,
								createdAt: "2026-10-05T00:00:00.000Z",
								file,
							},
						}),
			).rejects.toThrow("ownership transferred");
			expect(calls).toHaveLength(2);
			for (const headers of calls) {
				expect(headers.get("X-OpenCut-Account")).toBe("alice");
				expect(headers.get("X-OpenCut-Editor-Project")).toBe("film");
				expect(headers.get("X-OpenCut-Editor-Session")).toBe("old");
				expect(headers.get("X-OpenCut-Editor-Generation")).toBe("1");
			}
			// Disposing an old client must not remove the new owner's binding.
			expect(editorWriteHeaders(scope)["X-OpenCut-Editor-Session"]).toBe(
				"current",
			);
			expect(editorWriteHeaders({ ...scope, accountId: "bob" })).toEqual({});
			expect(editorWriteHeaders({ ...scope, projectId: "other" })).toEqual({});
		} finally {
			old.dispose();
			current.dispose();
			fetchMock.mockRestore();
			if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
			else Reflect.deleteProperty(globalThis, "window");
		}
		expect(editorWriteHeaders(scope)).toEqual({});
	});

test("definitive rejection and a late acquisition after disposal cannot leave usable write headers", async () => {
	const client = new EditorSessionClient({
		...scope,
		sessionId: "tab",
		exchange: async (request) => {
			if (request.type === "renew")
				throw new EditorSessionFailure({
					message: "Ownership lost",
					definitive: true,
				});
			return granted({ sessionId: "tab", generation: 1 });
		},
	});
	try {
		await client.acquire({ expectedGeneration: 0 });
		expect(editorWriteHeaders(scope)["X-OpenCut-Editor-Generation"]).toBe("1");
		await expect(client.renew()).rejects.toThrow("Ownership lost");
		expect(editorWriteHeaders(scope)).toEqual({});
	} finally {
		client.dispose();
	}
	let resolve!: (value: unknown) => void;
	let entered!: () => void;
	const started = new Promise<void>((done) => {
		entered = done;
	});
	const late = new EditorSessionClient({
		...scope,
		sessionId: "late",
		exchange: () => {
			entered();
			return new Promise((done) => {
				resolve = done;
			});
		},
	});
	const pending = late.acquire({ expectedGeneration: 0 });
	await started;
	late.dispose();
	resolve(granted({ sessionId: "late", generation: 1 }));
	await expect(pending).rejects.toThrow("closed");
	expect(editorWriteHeaders(scope)).toEqual({});
});
