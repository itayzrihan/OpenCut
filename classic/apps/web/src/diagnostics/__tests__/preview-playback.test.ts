import { expect, test } from "bun:test";
import {
	PreviewPlaybackProbe,
	type PreviewPlaybackReport,
} from "../preview-playback";

test("playback measurement excludes preparation, editing, disabled runs and repeated frames", () => {
	let now = 0;
	let enabled = false;
	const reports: PreviewPlaybackReport[] = [];
	const probe = new PreviewPlaybackProbe({
		now: () => now,
		enabled: () => enabled,
		report: (report) => reports.push(report),
	});
	probe.setPlaying({ playing: true, fps: 30 });
	expect(probe.beginFrame({ frame: 0 })).toBeNull();
	enabled = true;
	now = 5000;
	probe.setPlaying({ playing: false, fps: 30 });
	expect(probe.beginFrame({ frame: 0 })).toBeNull();
	probe.setPlaying({ playing: true, fps: 30 });
	now = 5010;
	const first = probe.beginFrame({ frame: 0 });
	now = 5020;
	probe.completeFrame({ ticket: first, transportLagMs: 10 });
	now = 5060;
	const second = probe.beginFrame({ frame: 2 });
	now = 5100;
	probe.completeFrame({ ticket: second, transportLagMs: 40 });
	now = 5105;
	const duplicate = probe.beginFrame({ frame: 2 });
	now = 5110;
	probe.completeFrame({ ticket: duplicate, transportLagMs: 5 });
	now = 5200;
	probe.setPlaying({ playing: false, fps: 30 });
	expect(reports).toHaveLength(1);
	expect(reports[0]).toMatchObject({
		reason: "pause",
		targetFps: 30,
		wallMs: 200,
		completedFrames: 3,
		distinctFrames: 2,
		firstFrame: 0,
		lastFrame: 2,
		skippedFrames: 1,
		completionFps: 10,
		firstFrameWaitMs: 20,
		renderMs: { mean: 18.33, p50: 10, p95: 40, max: 40 },
		errors: 0,
	});
});

test("seek and pause invalidate unfinished frames and start separate timing windows", () => {
	let now = 0;
	const reports: PreviewPlaybackReport[] = [];
	const probe = new PreviewPlaybackProbe({
		now: () => now,
		enabled: () => true,
		report: (report) => reports.push(report),
	});
	probe.setPlaying({ playing: true, fps: 30 });
	const old = probe.beginFrame({ frame: 100 });
	now = 1000;
	probe.restartForSeek();
	probe.completeFrame({ ticket: old, transportLagMs: 1000 });
	probe.failFrame({ ticket: old });
	const current = probe.beginFrame({ frame: 4 });
	now = 1020;
	probe.completeFrame({ ticket: current, transportLagMs: 20 });
	const unfinished = probe.beginFrame({ frame: 5 });
	now = 1040;
	probe.setPlaying({ playing: false, fps: 30 });
	probe.completeFrame({ ticket: unfinished, transportLagMs: 200 });
	expect(reports).toHaveLength(1);
	expect(reports[0]).toMatchObject({
		wallMs: 40,
		completedFrames: 1,
		firstFrame: 4,
		lastFrame: 4,
		skippedFrames: 0,
		errors: 0,
	});
});

test("long playback emits bounded windows and retains failed render counts", () => {
	let now = 0;
	const reports: PreviewPlaybackReport[] = [];
	const probe = new PreviewPlaybackProbe({
		now: () => now,
		enabled: () => true,
		report: (report) => reports.push(report),
	});
	probe.setPlaying({ playing: true, fps: 30 });
	for (let frame = 0; frame < 241; frame++) {
		const ticket = probe.beginFrame({ frame });
		now += 1000 / 30;
		probe.completeFrame({ ticket, transportLagMs: 1000 / 30 });
	}
	const failed = probe.beginFrame({ frame: 241 });
	probe.failFrame({ ticket: failed });
	probe.stop({ reason: "dispose" });
	expect(reports).toHaveLength(2);
	expect(reports[0]).toMatchObject({
		reason: "window",
		completedFrames: 240,
		completionFps: 30,
		skippedFrames: 0,
	});
	expect(reports[1]).toMatchObject({
		reason: "dispose",
		completedFrames: 1,
		firstFrame: 240,
		errors: 1,
	});
});
