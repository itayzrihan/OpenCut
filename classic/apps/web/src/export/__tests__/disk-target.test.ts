/* eslint-disable opencut/prefer-object-params -- Test doubles match the positional platform interfaces. */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Platform stream doubles verify transaction boundaries. */
import { expect, test, mock } from "bun:test";
class StreamTarget {
	constructor(
		readonly writable: WritableStream<{
			data: Uint8Array;
			position: number;
			type: "write";
		}>,
		readonly options: unknown,
	) {}
}
mock.module("mediabunny", () => ({ StreamTarget }));
const { DiskExportTarget } = await import("../disk-target");
function file(write: () => Promise<void> = async () => {}) {
	const state = { closes: 0, aborts: 0, writes: 0 };
	const handle = {
		createWritable: async () => ({
			write: async () => {
				state.writes++;
				await write();
			},
			close: async () => {
				state.closes++;
			},
			abort: async () => {
				state.aborts++;
			},
		}),
	} as unknown as FileSystemFileHandle;
	return { state, handle };
}
const chunk = { type: "write" as const, position: 0, data: new Uint8Array(16) };
test("muxer stream close never publishes a cancelled or incomplete file", async () => {
	const f = file(),
		disk = await DiskExportTarget.open(f.handle, new AbortController().signal);
	const stream = (disk.target as unknown as StreamTarget).writable.getWriter();
	await stream.write(chunk);
	await stream.close();
	expect(f.state.closes).toBe(0);
	await disk.abort();
	expect(f.state.aborts).toBe(1);
	expect(f.state.closes).toBe(0);
});
test("commit occurs once and cleanup cannot abort a successful file", async () => {
	const f = file(),
		disk = await DiskExportTarget.open(f.handle, new AbortController().signal);
	const stream = (disk.target as unknown as StreamTarget).writable.getWriter();
	await stream.write(chunk);
	await stream.close();
	await disk.commit();
	await disk.abort();
	expect(f.state).toEqual({ closes: 1, aborts: 0, writes: 1 });
});
test("slow disk applies backpressure; cancellation and artifact size stop subsequent writes", async () => {
	let release!: () => void;
	const f = file(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		),
		controller = new AbortController();
	const disk = await DiskExportTarget.open(f.handle, controller.signal, 20);
	const stream = (disk.target as unknown as StreamTarget).writable.getWriter();
	let done = false;
	const writing = stream.write(chunk).then(() => {
		done = true;
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(done).toBe(false);
	release();
	await writing;
	expect(done).toBe(true);
	controller.abort();
	await expect(stream.write(chunk)).rejects.toThrow();
	expect(f.state.writes).toBe(1);
	await disk.abort();
	expect(f.state.aborts).toBe(1);
	const second = file(),
		limited = await DiskExportTarget.open(
			second.handle,
			new AbortController().signal,
			15,
		);
	const writer = (
		limited.target as unknown as StreamTarget
	).writable.getWriter();
	await expect(writer.write(chunk)).rejects.toThrow("artifact limit");
	expect(second.state.writes).toBe(0);
	await limited.abort();
});
