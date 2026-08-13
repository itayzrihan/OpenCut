import { describe, expect, test } from "bun:test";
import {
	getAudibleContextTime,
	getAudioContextStartTime,
	getAudioRecoveryTimelineTime,
	getStreamingSourceDuration,
	mapRetimeToTimelineScale,
} from "@/core/managers/audio-sync";

describe("audio sync", () => {
	test("maps the audio output timestamp onto the current wall clock", () => {
		expect(
			getAudibleContextTime({
				contextTime: 12,
				performanceTime: 10_050,
				outputTimestamp: {
					contextTime: 11.9,
					performanceTime: 10_000,
				},
				outputLatency: 0.25,
			}),
		).toBeCloseTo(11.95, 8);
	});

	test("falls back to reported output latency when no timestamp is available", () => {
		expect(
			getAudibleContextTime({
				contextTime: 12,
				performanceTime: 10_050,
				outputTimestamp: {
					contextTime: 0,
					performanceTime: 0,
				},
				outputLatency: 0.08,
			}),
		).toBeCloseTo(11.92, 8);
	});

	test("keeps scheduling finite when a browser reports invalid latency", () => {
		expect(
			getAudibleContextTime({
				contextTime: 12,
				performanceTime: 10_050,
				outputLatency: Number.NaN,
			}),
		).toBe(12);
	});

	test("schedules audio against the live timeline instead of a stale start time", () => {
		expect(
			getAudioContextStartTime({
				audibleContextTime: 20,
				playbackTime: 4.75,
				timelineTime: 5,
			}),
		).toBeCloseTo(20.25, 8);
	});

	test("recovers a fully missed buffer at the next schedulable timeline point", () => {
		expect(
			getAudioRecoveryTimelineTime({
				bufferTimelineTime: 4.5,
				contextStartTime: 19.5,
				currentContextTime: 20.25,
				playbackTime: 5.2,
				safetyMargin: 0.02,
			}),
		).toBeCloseTo(5.27, 8);
	});

	test("never seeks recovery behind the live playback clock", () => {
		expect(
			getAudioRecoveryTimelineTime({
				bufferTimelineTime: 4,
				contextStartTime: 20,
				currentContextTime: 20.1,
				playbackTime: 5.5,
			}),
		).toBe(5.5);
	});

	test("clips a streaming buffer exactly at the timeline clip boundary", () => {
		expect(
			getStreamingSourceDuration({
				bufferDuration: 10,
				sourceOffset: 0.5,
				playbackRate: 2,
				bufferTimelineTime: 4,
				clipEndTime: 6,
				contextLateness: 0.25,
			}),
		).toBeCloseTo(3.5, 8);
	});

	test("does not schedule a streaming buffer after its clip has ended", () => {
		expect(
			getStreamingSourceDuration({
				bufferDuration: 1,
				sourceOffset: 0,
				playbackRate: 1,
				bufferTimelineTime: 6,
				clipEndTime: 6,
				contextLateness: 0,
			}),
		).toBe(0);
	});

	test("retimes parent audio when a parallax scene uses a different duration", () => {
		expect(
			mapRetimeToTimelineScale({
				timelineScale: 2,
			}),
		).toEqual({ rate: 2 });
	});

	test("preserves existing retime settings while mapping parallax duration", () => {
		expect(
			mapRetimeToTimelineScale({
				retime: { rate: 0.75, maintainPitch: true },
				timelineScale: 2,
			}),
		).toEqual({ rate: 1.5, maintainPitch: true });
	});

	test("keeps ordinary one-to-one audio free of redundant retime settings", () => {
		expect(
			mapRetimeToTimelineScale({
				timelineScale: 1,
			}),
		).toBeUndefined();
	});
});
