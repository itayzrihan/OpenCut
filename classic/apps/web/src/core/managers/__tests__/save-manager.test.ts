import { describe, expect, mock, spyOn, test } from "bun:test";
import type { EditorCore } from "@/core";
import { SaveManager } from "@/core/managers/save-manager";

function createSaveManager({
	saveCurrentProject,
	debounceMs = 0,
	retryDelaysMs = [0],
}: {
	saveCurrentProject: () => Promise<void>;
	debounceMs?: number;
	retryDelaysMs?: readonly number[];
}) {
	const editor = {
		project: {
			getActiveOrNull: () => ({ metadata: { id: "project-1" } }),
			getIsLoading: () => false,
			getMigrationState: () => ({ isMigrating: false }),
			saveCurrentProject,
		},
	} as unknown as EditorCore;

	return new SaveManager({ editor, debounceMs, retryDelaysMs });
}

async function waitFor({
	predicate,
	timeoutMs = 250,
}: {
	predicate: () => boolean;
	timeoutMs?: number;
}): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error("Timed out waiting for save state");
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

describe("SaveManager", () => {
	test("viewer notifications do not schedule archive saves; content notifications still do", () => {
		let content!: () => void;
		const broadSubscribe = mock(() => () => {});
		const editor = {
			scenes: {
				subscribe: broadSubscribe,
				subscribeContent: (listener: () => void) => {
					content = listener;
					return () => {};
				},
			},
			timeline: { subscribe: () => () => {} },
			project: { getActiveOrNull: () => ({ metadata: { id: "p" } }) },
		} as unknown as EditorCore;
		const manager = new SaveManager({ editor });
		manager.start();
		expect(broadSubscribe).not.toHaveBeenCalled();
		expect(manager.getIsDirty()).toBe(false);
		content();
		expect(manager.getIsDirty()).toBe(true);
		manager.stop();
	});
	test("propagates a failed flush and keeps the project dirty", async () => {
		const failure = new Error("IndexedDB write failed");
		const manager = createSaveManager({
			saveCurrentProject: mock(async () => {
				throw failure;
			}),
			retryDelaysMs: [10_000],
		});

		try {
			await expect(manager.flush()).rejects.toBe(failure);
			expect(manager.getIsDirty()).toBe(true);
		} finally {
			manager.stop();
		}
	});

	test("retries a failed autosave and clears dirty state only after success", async () => {
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		let attempts = 0;
		const saveCurrentProject = mock(async () => {
			attempts += 1;
			if (attempts === 1) {
				throw new Error("temporary storage failure");
			}
		});
		const manager = createSaveManager({ saveCurrentProject });

		try {
			manager.markDirty();
			await waitFor({
				predicate: () => attempts === 2 && !manager.getIsDirty(),
			});

			expect(saveCurrentProject).toHaveBeenCalledTimes(2);
			expect(manager.getIsDirty()).toBe(false);
		} finally {
			manager.stop();
			errorSpy.mockRestore();
		}
	});

	test("flush writes a newer edit that arrives during an in-flight save", async () => {
		let finishFirstSave = () => {};
		const firstSave = new Promise<void>((resolve) => {
			finishFirstSave = resolve;
		});
		let attempts = 0;
		const saveCurrentProject = mock(async () => {
			attempts += 1;
			if (attempts === 1) {
				await firstSave;
			}
		});
		const manager = createSaveManager({
			saveCurrentProject,
			debounceMs: 10_000,
		});

		try {
			const flushPromise = manager.flush();
			await waitFor({ predicate: () => attempts === 1 });
			manager.markDirty();
			finishFirstSave();
			await flushPromise;

			expect(saveCurrentProject).toHaveBeenCalledTimes(2);
			expect(manager.getIsDirty()).toBe(false);
		} finally {
			manager.stop();
		}
	});

	test("a forced dirty mark waits for resume while saving is paused", async () => {
		const saveCurrentProject = mock(async () => {});
		const manager = createSaveManager({ saveCurrentProject });

		try {
			manager.pause();
			manager.markDirty({ force: true });
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(saveCurrentProject).not.toHaveBeenCalled();
			expect(manager.getIsDirty()).toBe(true);

			manager.resume();
			await waitFor({ predicate: () => !manager.getIsDirty() });
			expect(saveCurrentProject).toHaveBeenCalledTimes(1);
		} finally {
			manager.stop();
		}
	});
});

test("exit flush skips a clean project but persists dirty changes", async () => {
	const save = mock(async () => {});
	const manager = createSaveManager({
		saveCurrentProject: save,
		debounceMs: 10000,
	});
	await manager.flush({ onlyPending: true });
	expect(save).toHaveBeenCalledTimes(0);
	manager.markDirty();
	await manager.flush({ onlyPending: true });
	expect(save).toHaveBeenCalledTimes(1);
	await manager.flush({ onlyPending: true });
	expect(save).toHaveBeenCalledTimes(1);
	manager.stop();
});
