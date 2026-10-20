/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Platform handle doubles. */
import { test, expect } from "bun:test";
import { ExportScratch } from "../scratch";

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
