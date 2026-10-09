import { expect, test } from "bun:test";
import {
	publishPerformanceReport,
	readPerformanceReports,
	subscribePerformanceReports,
} from "../performance-reports";

test("production diagnostics remain available without console and retain only a bounded window", () => {
	let notifications = 0;
	const unsubscribe = subscribePerformanceReports(() => notifications++);
	for (let index = 0; index < 200; index++)
		publishPerformanceReport({
			kind: "playback",
			data: { completedFrames: index },
		});
	expect(readPerformanceReports()).toHaveLength(120);
	expect(readPerformanceReports().at(-1)?.data).toEqual({
		completedFrames: 199,
	});
	expect(notifications).toBe(200);
	unsubscribe();
	publishPerformanceReport({ kind: "render", data: {} });
	expect(notifications).toBe(200);
});
