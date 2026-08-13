import { describe, expect, test } from "bun:test";
import type { TimelineTrack } from "@/timeline/types";
import {
	getParallaxWorldMotionFactor,
	resolveParallaxTrackAssignments,
} from "../parallax-tracks";

function emptyVideo(id: string): TimelineTrack {
	return {
		id,
		name: id,
		type: "video",
		elements: [],
		hidden: false,
		muted: false,
	};
}

describe("Parallax Track hierarchy", () => {
	test("applies each marker until the next marker and leaves earlier tracks unassigned", () => {
		const tracks: TimelineTrack[] = [
			emptyVideo("screen-locked"),
			{
				id: "near-marker",
				name: "Near",
				type: "parallax",
				elements: [],
				direction: "with-camera",
				speedPercent: 125,
			},
			emptyVideo("near-content"),
			{
				id: "far-marker",
				name: "Far",
				type: "parallax",
				elements: [],
				direction: "against-camera",
				speedPercent: 30,
			},
			emptyVideo("far-content"),
		];

		const assignments = resolveParallaxTrackAssignments({ tracks });

		expect(assignments.has("screen-locked")).toBe(false);
		expect(assignments.get("near-content")?.motionFactor).toBe(-1.25);
		expect(assignments.get("far-content")?.motionFactor).toBe(0.3);
		expect(
			getParallaxWorldMotionFactor({
				assignment: assignments.get("screen-locked"),
			}),
		).toBe(1);
		expect(
			getParallaxWorldMotionFactor({
				assignment: assignments.get("far-content"),
			}),
		).toBe(0.3);
	});
});
