/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Host doubles use fixture data; restoration and source serialization use the real WASM. */
import { expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import type { TScene } from "@/timeline/types";
import type { MediaTime } from "@/wasm/media-time";

const glue = await import("../../../../../rust/wasm/pkg/opencut_wasm_bg.js");
const { instance } = await WebAssembly.instantiate(
	await Bun.file(
		new URL(
			"../../../../../rust/wasm/pkg/opencut_wasm_bg.wasm",
			import.meta.url,
		),
	).arrayBuffer(),
	{ "./opencut_wasm_bg.js": glue },
);
glue.__wbg_set_wasm(instance.exports);
const start = instance.exports.__wbindgen_start;
if (typeof start !== "function") throw new Error("Missing WASM startup export");
start();
mock.module("opencut-wasm", () => glue);
mock.module("@/timeline/scenes", () => ({
	updateSceneInArray: ({
		scenes,
		sceneId,
		updates,
	}: {
		scenes: TScene[];
		sceneId: string;
		updates: Partial<TScene>;
	}) =>
		scenes.map((scene) =>
			scene.id === sceneId ? { ...scene, ...updates } : scene,
		),
}));
const { restoreSelectedSilence, previewRestoreSilence } =
	await import("../restore-silence");

async function fixture() {
	const data = await Bun.file(
		new URL(
			"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
			import.meta.url,
		),
	).json();
	const project = data.document as TProject;
	let scene = project.scenes[0];
	scene.createdAt = new Date(scene.createdAt);
	scene.updatedAt = new Date(scene.updatedAt);
	scene.tracks.overlay = [];
	scene.tracks.audio = [];
	scene.bookmarks = [];
	const original = scene.tracks.main.elements[0];
	scene.tracks.main.elements = [1, 3, 6, 8, 10].map((source, index) => ({
		...original,
		id: String(index),
		startTime: index * 120000,
		duration: 120000,
		trimStart: source * 120000,
		trimEnd: (20 - source - 1) * 120000,
		retime: { rate: 1 },
	})) as typeof scene.tracks.main.elements;
	let duringEnable = () => {};
	let writes = 0;
	const editor = {
		project: { getActive: () => project },
		scenes: {
			getActiveScene: () => scene,
			getScenes: () => [scene],
			setScenes: ({ scenes }: { scenes: TScene[] }) => {
				scene = scenes[0];
				writes++;
			},
		},
		command: {
			enableCanonical: async () => {
				duringEnable();
			},
			executeSilenceTransaction: ({
				operation,
				execute,
			}: {
				operation: string;
				execute: () => void;
			}) => {
				expect(operation).toBe("restore");
				execute();
			},
		},
		save: { markDirty: () => {} },
	} as unknown as EditorCore;
	const selection = (ids: string[]) =>
		ids.map((elementId) => ({ trackId: scene.tracks.main.id, elementId }));
	return {
		editor,
		project,
		scene: () => scene,
		selection,
		writes: () => writes,
		onEnable: (callback: () => void) => {
			duringEnable = callback;
		},
	};
}

for (const ids of [
	["2", "1"],
	["3", "1", "2"],
]) {
	test(`real WASM restores only the ${ids.length - 1} internal gaps of ${ids.length} selected clips`, async () => {
		const host = await fixture();
		const before = structuredClone(host.scene().tracks.main.elements);
		const result = await restoreSelectedSilence({
			editor: host.editor,
			selection: host.selection(ids),
		});
		const after = host.scene().tracks.main.elements;
		const last = ids.length;
		expect(result.restoredGapCount).toBe(ids.length - 1);
		expect(result.restoredDuration).toBe((ids.length === 2 ? 2 : 3) * 120000);
		// Both outer source gaps remain exactly as cut, even with unselected neighbors.
		expect(after[1].trimStart).toBe(before[1].trimStart);
		expect(after[1].startTime).toBe(before[1].startTime);
		expect(after[last].trimEnd).toBe(before[last].trimEnd);
		expect(after[last].duration).toBe(before[last].duration);
		for (let i = 0; i < after.length; i++) {
			expect(after[i].trimStart).toBe(before[i].trimStart);
			if (i === 0 || i >= last) {
				expect(after[i].duration).toBe(before[i].duration);
				expect(after[i].trimEnd).toBe(before[i].trimEnd);
			}
		}
		expect(after[4].startTime - before[4].startTime).toBe(
			result.restoredDuration,
		);
		expect(host.writes()).toBe(1);
		expect(
			previewRestoreSilence({
				editor: host.editor,
				selection: host.selection(ids),
			}),
		).toBeNull();
	});
}

test("selection expansion while enabling the session cannot restore outer gaps", async () => {
	const host = await fixture();
	const selection = host.selection(["1", "2"]);
	host.onEnable(() => selection.push(...host.selection(["0", "3", "4"])));
	const result = await restoreSelectedSilence({
		editor: host.editor,
		selection,
	});
	expect(result.restoredGapCount).toBe(1);
	expect(result.restoredDuration).toBe(240000);
});

for (const change of ["project", "scene", "trim"]) {
	test(`rejects ${change} changes during session preparation without publishing`, async () => {
		const host = await fixture();
		host.onEnable(() => {
			if (change === "project") host.project.metadata.id = "other-project";
			else if (change === "scene") host.scene().id = "other-scene";
			else host.scene().tracks.main.elements[1].trimStart = 0 as MediaTime;
		});
		await expect(
			restoreSelectedSilence({
				editor: host.editor,
				selection: host.selection(["1", "2"]),
			}),
		).rejects.toThrow("הטיימליין השתנה");
		expect(host.writes()).toBe(0);
	});
}

test("one clip and nonconsecutive clips never restore their outer handles", async () => {
	const host = await fixture();
	for (const ids of [["1"], ["1", "3"]]) {
		await expect(
			restoreSelectedSilence({
				editor: host.editor,
				selection: host.selection(ids),
			}),
		).rejects.toThrow("בחרו קליפים צמודים");
	}
	expect(host.writes()).toBe(0);
});
