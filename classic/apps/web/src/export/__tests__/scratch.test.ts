/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Platform handle doubles. */
import { test, expect } from "bun:test";
import { ExportScratch, checkExportDiskSpace } from "../scratch";

async function fixture({ brokenIterator = false } = {}) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	const warn = console.warn;
	const old = `${Date.now() - 172800000}-old`,
		active = `${Date.now() - 172800000}-active`;
	const removed: string[] = [];
	const warnings: string[] = [];
	let iterating = false;
	const parent = {
		async *keys() {
			if (brokenIterator)
				throw new DOMException(
					"Cached directory state changed",
					"NotReadableError",
				);
			iterating = true;
			try {
				for (const name of [old, active]) {
					if (removed.length)
						throw new DOMException(
							"Iterator invalidated by deletion",
							"NotReadableError",
						);
					yield name;
				}
			} finally {
				iterating = false;
			}
		},
		removeEntry: async (name: string) => {
			expect(iterating).toBe(false);
			removed.push(name);
		},
		getDirectoryHandle: async (name: string) => ({ name }),
	};
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			storage: {
				getDirectory: async () => ({ getDirectoryHandle: async () => parent }),
			},
			locks: {
				request: async (
					name: string,
					options: unknown,
					callback?: (lock: unknown) => unknown,
				) =>
					callback
						? callback(name.endsWith("-active") ? null : {})
						: (options as () => unknown)(),
			},
		},
	});
	console.warn = (...args: unknown[]) => {
		warnings.push(args.join(" "));
	};
	try {
		const scratch = await ExportScratch.create();
		expect(removed).not.toContain(active);
		expect(removed).toEqual(brokenIterator ? [] : [old]);
		expect(warnings.length).toBe(brokenIterator ? 1 : 0);
		await scratch.dispose();
	} finally {
		console.warn = warn;
		if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
		else Reflect.deleteProperty(globalThis, "navigator");
	}
}
test("snapshots expired scratch names before deletion and protects another tab lease", () =>
	fixture());
test("a stale OPFS directory iterator never prevents a new audio job", () =>
	fixture({ brokenIterator: true }));

test("storage failures identify browser allowance and report remaining capacity", async () => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			storage: {
				estimate: async () => ({
					quota: 30 * 1024 ** 3,
					usage: 20 * 1024 ** 3,
				}),
			},
		},
	});
	try {
		await checkExportDiskSpace(9 * 1024 ** 3);
		await expect(checkExportDiskSpace(12 * 1024 ** 3)).rejects.toThrow(
			"browser reports 10.00 GiB available",
		);
		await expect(checkExportDiskSpace(12 * 1024 ** 3)).rejects.toThrow(
			"separate from your Mac's free disk space",
		);
	} finally {
		if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
		else Reflect.deleteProperty(globalThis, "navigator");
	}
});

test("unavailable or invalid advisory estimates leave real write checks in charge", async () => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	try {
		for (const storage of [
			undefined,
			{},
			{
				estimate: async () => {
					throw new Error("Estimate unavailable");
				},
			},
			{ estimate: async () => ({ quota: NaN, usage: 10 }) },
			{ estimate: async () => ({ quota: -1, usage: 0 }) },
		]) {
			Object.defineProperty(globalThis, "navigator", {
				configurable: true,
				value: { storage },
			});
			await checkExportDiskSpace(12 * 1024 ** 3);
		}
	} finally {
		if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
		else Reflect.deleteProperty(globalThis, "navigator");
	}
});
