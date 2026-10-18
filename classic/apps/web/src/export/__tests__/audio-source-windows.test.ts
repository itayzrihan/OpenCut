import { expect, mock, test } from "bun:test";
import type { AudioClipSource } from "@/media/audio";
mock.module("@/retime", () => ({
	getSourceTimeAtClipTime: ({
		clipTime,
		retime,
	}: {
		clipTime: number;
		retime?: { rate: number };
	}) => clipTime * (retime?.rate ?? 1),
}));
const { exportSourceWindows } = await import("../audio-source-windows");
function range(
	trimStart: number,
	duration: number,
	retime?: AudioClipSource["retime"],
): AudioClipSource {
	return { trimStart, duration, retime } as AudioClipSource;
}
test("late episode cuts decode their ranges, never the preceding hour or removed gaps", () => {
	const windows = exportSourceWindows([
		range(3600, 10),
		range(5000, 20),
		range(3605, 10),
	]);
	expect(windows).toEqual([
		{ start: 3599.75, end: 3615.1 },
		{ start: 4999.75, end: 5020.1 },
	]);
	expect(
		windows.reduce((n, window) => n + window.end - window.start, 0),
	).toBeLessThan(40);
});
test("source handles include rate and pitch lookahead while zero-time clips stay bounded", () => {
	expect(
		exportSourceWindows([range(0, 4, { rate: 2, maintainPitch: true })]),
	).toEqual([{ start: 0, end: 11.1 }]);
});
