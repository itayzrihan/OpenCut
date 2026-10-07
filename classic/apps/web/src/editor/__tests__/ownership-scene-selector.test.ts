import { expect, mock, test } from "bun:test";

const sceneListeners = new Set<() => void>();
const projectListeners = new Set<() => void>();
let loading = false;
let scene: { id: string } | null = { id: "old" };
let changes = 0;
let captured: (() => unknown) | undefined;
const editor = {
	project: {
		getIsLoading: () => loading,
		subscribe: (fn: () => void) => {
			projectListeners.add(fn);
			return () => projectListeners.delete(fn);
		},
	},
	scenes: {
		getActiveScene: () => {
			if (!scene) throw new Error("No active scene.");
			return scene;
		},
		subscribe: (fn: () => void) => {
			sceneListeners.add(fn);
			return () => sceneListeners.delete(fn);
		},
	},
	timeline: { subscribe: () => () => {} },
};
mock.module("@/core", () => ({ EditorCore: { getInstance: () => editor } }));
// Drive the real hook's external-store callbacks synchronously, as React does
// when a store notifies before the loading view has committed/unmounted.
mock.module("react", () => ({
	useMemo: (fn: () => unknown) => fn(),
	useRef: (value: unknown) => ({ current: value }),
	useCallback: (fn: unknown) => fn,
	// eslint-disable-next-line opencut/prefer-object-params -- The fixture implements React's positional hook signature.
	useSyncExternalStore: (
		subscribe: (fn: () => void) => () => void,
		getSnapshot: () => unknown,
	) => {
		captured = getSnapshot;
		subscribe(() => {
			getSnapshot();
			changes++;
		});
		return getSnapshot();
	},
}));

test("ownership replacement never evaluates scene selectors during the clear/restore gap", async () => {
	const { useEditorTimelineScenes } = await import("../use-editor");
	let reads = 0;
	expect(
		useEditorTimelineScenes((e) => {
			reads++;
			return e.scenes.getActiveScene().id;
		}),
	).toBe("old");
	loading = true;
	for (const listener of projectListeners) listener();
	scene = null;
	expect(() => {
		for (const listener of sceneListeners) listener();
	}).not.toThrow();
	expect(captured?.()).toBe("old");
	expect(reads).toBe(1);
	scene = { id: "restored" };
	for (const listener of sceneListeners) listener();
	loading = false;
	for (const listener of projectListeners) listener();
	expect(captured?.()).toBe("restored");
	expect(changes).toBeGreaterThan(0);
});
