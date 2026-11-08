// @opencut-test-wasm: real
/* The filesystem receipt is scripted here; transfer tests exercise real bytes.
 * This suite verifies the real nested canonical binding transaction while the
 * discovered host capability is pending, including unchanged edit history. */
import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { EditorCore } from "@/core";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "@/core/canonical-classic-session";
import { mediaRelinkBinding } from "opencut-wasm";
import { performPeerMediaEffect } from "./editor-effect";

test("reopening refreshes missing and recovered sources without mixing host edits or changing Undo boundaries", async () => {
	const runtime = await createCanonicalTestRuntime();
	const session = new CanonicalClassicSession({
		runtime,
		projectId: "classic-project",
	});
	const classic = JSON.parse(
		readFileSync(
			new URL(
				"../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	) as CanonicalClassicSnapshot;
	Object.assign(classic.mediaAssets[0], {
		missing: false,
		sourcePath: "C:/other-machine/original.mp4",
		bindingRevision: 1,
		future: { keep: true },
	});
	session.attach({
		classic,
		undoStack: [
			{
				label: "Existing edit",
				classic: structuredClone(classic),
				hostContext: {},
			},
		],
	});
	const archive = session.archive();
	const freshRuntime = await createCanonicalTestRuntime();
	const reopened = new CanonicalClassicSession({
		runtime: freshRuntime,
		projectId: "classic-project",
	});
	try {
		reopened.restore(archive);
		const saved = reopened.read();
		const observed = {
			...saved.mediaAssets[0],
			name: "Stale host name",
			missing: true,
			sourcePath: "C:/this-machine/missing.mp4",
		};
		reopened.refreshLocalMediaBindings({
			bindings: [observed, { ...observed, id: "orphan-on-disk" }],
		});
		expect(reopened.read().document).toEqual(saved.document);
		expect(reopened.read().mediaAssets).toHaveLength(saved.mediaAssets.length);
		expect(reopened.read().mediaAssets[0]).toMatchObject({
			name: saved.mediaAssets[0].name,
			missing: true,
			future: { keep: true },
		});
		expect(reopened.archive().undoStack).toHaveLength(archive.undoStack.length);
		expect(reopened.archive().redoStack).toEqual(archive.redoStack);
		reopened.refreshLocalMediaBindings({
			bindings: [
				{
					...observed,
					missing: false,
					sourcePath: "C:/verified/original.mp4",
					bindingRevision: 2,
				},
			],
		});
		expect(reopened.read().mediaAssets[0]).toMatchObject({
			missing: false,
			sourcePath: "C:/verified/original.mp4",
			bindingRevision: 2,
		});
		// Archives encode boundaries as deltas against the current state, so their
		// bytes change after a metadata refresh. Their decoded historical states
		// must still match the original session exactly.
		session.undo();
		reopened.undo();
		expect(reopened.read()).toEqual(session.read());
		reopened.redo();
		expect(reopened.read().document).toEqual(saved.document);
	} finally {
		runtime.free();
		freshRuntime.free();
	}
});

test("verified relink runs through the registry and app.state.read while preserving cuts and Undo boundaries", async () => {
	const runtime = await createCanonicalTestRuntime(),
		session = new CanonicalClassicSession({
			runtime,
			projectId: "classic-project",
		});
	const classic = JSON.parse(
		readFileSync(
			new URL(
				"../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	) as CanonicalClassicSnapshot;
	Object.assign(
		classic.mediaAssets.find((asset) => asset.id === "video-asset")!,
		{
			size: 10,
			lastModified: 1234,
			missing: true,
			sourcePath: "C:/old/missing.mp4",
			bindingRevision: 2,
			future: { keep: true },
		},
	);
	classic.mediaAssets.push({
		id: "unrelated",
		name: "Unrelated",
		type: "image",
		size: 5,
		lastModified: 1234,
	});
	session.attach({ classic });
	const before = session.read(),
		status = session.status();
	const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { __opencutAccountId: "alice" },
	});
	const fetchMock = spyOn(globalThis, "fetch");
	const editor = {
		project: {
			getActiveOrNull: () => ({ metadata: { id: "classic-project" } }),
		},
		command: { getCanonicalRevision: () => session.status().revision },
		media: {
			getAssets: () => session.read().mediaAssets,
			relink: async (input: {
				id: string;
				source: string;
				expectedRevision: number;
			}) => {
				const current = session.read(),
					old = current.mediaAssets.find((asset) => asset.id === input.id)!;
				const next = JSON.parse(
					mediaRelinkBinding({
						recordJson: JSON.stringify(old),
						source: input.source,
						expectedRevision: input.expectedRevision,
						undo: false,
						replacementMetadataJson: JSON.stringify({
							size: 10,
							lastModified: 1234,
						}),
					}),
				);
				session.synchronize({
					classic: {
						...current,
						mediaAssets: current.mediaAssets.map((asset) =>
							asset.id === input.id ? next : asset,
						),
					},
				});
			},
		},
	} as unknown as EditorCore;
	try {
		fetchMock.mockResolvedValue(
			Response.json({
				source: "C:/owned/verified-original.mp4",
				job: {
					projectId: "classic-project",
					mediaId: "video-asset",
					deviceId: "laptop",
					operationId: "pull-1",
					expectedBindingRevision: 2,
					status: "ready",
					phase: "ready",
					receivedBytes: 10,
					totalBytes: 10,
				},
			}),
		);
		const receipt = await session.invokeMcp({
			capabilityId: "media.transfer.commit",
			input: {
				projectId: "classic-project",
				expectedRevision: status.revision,
				operationId: "pull-1",
			},
			context: { dryRun: false, metadata: {} },
			signal: new AbortController().signal,
			host: (effect) =>
				performPeerMediaEffect({
					effect,
					editor,
					accountId: "alice",
					signal: new AbortController().signal,
				}),
		});
		expect(
			z
				.object({
					result: z.object({ data: z.object({ linked: z.literal(true) }) }),
				})
				.safeParse(receipt).success,
		).toBe(true);
		const after = session.read();
		expect(after.document).toEqual(before.document);
		expect(after.mediaAssets.find((asset) => asset.id === "unrelated")).toEqual(
			before.mediaAssets.find((asset) => asset.id === "unrelated"),
		);
		expect(
			after.mediaAssets.find((asset) => asset.id === "video-asset"),
		).toMatchObject({
			id: "video-asset",
			missing: false,
			bindingRevision: 3,
			duration: 16,
			future: { keep: true },
		});
		expect(session.status().canUndo).toBe(status.canUndo);
		expect(session.status().canRedo).toBe(status.canRedo);
		const read = runtime.invokeSync(
			"app.state.read",
			{ projectId: "classic-project", pointer: "/project/classic/mediaAssets" },
			{},
		);
		expect(
			z
				.object({
					result: z.object({
						data: z.object({
							value: z.array(z.record(z.string(), z.unknown())),
						}),
					}),
				})
				.parse(read)
				.result.data.value.find((asset) => asset.id === "video-asset")?.missing,
		).toBe(false);
	} finally {
		fetchMock.mockRestore();
		runtime.free();
		if (previous) Object.defineProperty(globalThis, "window", previous);
		else Reflect.deleteProperty(globalThis, "window");
	}
}, 30_000);
