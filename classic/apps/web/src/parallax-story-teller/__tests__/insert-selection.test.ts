import { describe, expect, test } from "bun:test";
import {
	buildCanvasPanElement,
	buildCanvasPanScene,
	linkParallaxSceneToElement,
} from "@/parallax-story-teller/model";
import { insertSelectionIntoCanvas } from "@/parallax-story-teller/insert-selection";
import type {
	ImageElement,
	TextElement,
	TextTrack,
	TimelineElement,
	TScene,
	VideoTrack,
} from "@/timeline/types";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";

const seconds = (value: number) => mediaTimeFromSeconds({ seconds: value });

function fixture() {
	const setup = {
		direction: "right" as const,
		durationSeconds: 6,
		worldWidthFrames: 3,
	};
	const rawChild = buildCanvasPanScene({ parentSceneId: "parent", setup });
	const story = {
		...buildCanvasPanElement({
			sceneId: rawChild.id,
			startTime: seconds(10),
			setup,
		}),
		id: "story",
	};
	const child = linkParallaxSceneToElement({
		scene: {
			...rawChild,
			tracks: {
				...rawChild.tracks,
				overlay: [
					...rawChild.tracks.overlay,
					{
						id: "inside-track",
						name: "Inside",
						type: "text",
						hidden: false,
						elements: [textElement({ id: "inside", start: 1, duration: 2 })],
					},
				],
			},
		},
		elementId: story.id,
	});
	const textTrack: TextTrack = {
		id: "text-track",
		name: "Titles",
		type: "text",
		hidden: false,
		elements: [textElement({ id: "early", start: 8, duration: 2 })],
	};
	const videoTrack: VideoTrack = {
		id: "video-track",
		name: "Images",
		type: "video",
		hidden: false,
		muted: false,
		elements: [imageElement({ id: "late", start: 18, duration: 3 })],
	};
	const storyTrack = {
		id: "story-track",
		name: "Parallax",
		type: "effect" as const,
		hidden: false,
		elements: [story],
	};
	const parent: TScene = {
		id: "parent",
		name: "Parent",
		isMain: true,
		tracks: {
			overlay: [storyTrack, textTrack, videoTrack],
			main: {
				id: "main",
				name: "Main",
				type: "video",
				elements: [],
				hidden: false,
				muted: false,
			},
			audio: [],
			order: [storyTrack.id, textTrack.id, videoTrack.id, "main"],
		},
		bookmarks: [],
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const selection = [
		{ trackId: storyTrack.id, elementId: story.id },
		{ trackId: textTrack.id, elementId: "early" },
		{ trackId: videoTrack.id, elementId: "late" },
	];
	return { parent, child, selection };
}

describe("insert selection into Parallax Canvas", () => {
	test("moves layers, preserves track separation and expands both clip edges", () => {
		const { parent, child, selection } = fixture();
		let nextId = 0;
		const result = insertSelectionIntoCanvas({
			scenes: [parent, child],
			parentSceneId: parent.id,
			parallaxElementId: "story",
			selectedElements: selection,
			mode: "move",
			createId: () => `new-${++nextId}`,
		});
		expect(result).not.toBeNull();
		const nextParent = result!.scenes.find((scene) => scene.id === parent.id)!;
		const nextChild = result!.scenes.find((scene) => scene.id === child.id)!;
		const nextStory = overlayElements(nextParent).find(
			(element) => element.id === "story",
		)!;

		expect(nextStory.startTime).toBe(seconds(8));
		expect(nextStory.duration).toBe(seconds(13));
		expect(
			overlayElements(nextParent).map((item) => item.id),
		).toEqual(["story"]);
		expect(nextChild.tracks.overlay.slice(0, 2).map((track) => track.type)).toEqual([
			"text",
			"video",
		]);
		const imported = elementsFromTracks(nextChild.tracks.overlay.slice(0, 2));
		expect(imported.map((element) => [element.id, element.startTime])).toEqual([
			["early", seconds(0)],
			["late", seconds(10)],
		]);
		const shiftedInside = overlayElements(nextChild)
			.find((element) => element.id === "inside")!;
		expect(shiftedInside.startTime).toBe(seconds(3));
		const cameraGuide = overlayElements(nextChild)
			.find((element) => element.params.kind === "parallax-camera-guide")!;
		expect(cameraGuide.duration).toBe(seconds(13));
	});

	test("duplicates layers with fresh ids and leaves originals untouched", () => {
		const { parent, child, selection } = fixture();
		let nextId = 0;
		const result = insertSelectionIntoCanvas({
			scenes: [parent, child],
			parentSceneId: parent.id,
			parallaxElementId: "story",
			selectedElements: selection,
			mode: "duplicate",
			createId: () => `copy-${++nextId}`,
		})!;
		const nextParent = result.scenes.find((scene) => scene.id === parent.id)!;
		const parentIds = overlayElements(nextParent).map((element) => element.id);
		expect(parentIds).toEqual(["story", "early", "late"]);
		expect(result.importedElementRefs.map((ref) => ref.elementId)).toEqual([
			"copy-2",
			"copy-4",
		]);
	});
});

function overlayElements(scene: TScene): TimelineElement[] {
	return elementsFromTracks(scene.tracks.overlay);
}

function elementsFromTracks(
	tracks: TScene["tracks"]["overlay"],
): TimelineElement[] {
	const elements: TimelineElement[] = [];
	for (const track of tracks) {
		for (const element of track.elements) elements.push(element);
	}
	return elements;
}

function textElement({
	id,
	start,
	duration,
}: {
	id: string;
	start: number;
	duration: number;
}): TextElement {
	return {
		id,
		name: id,
		type: "text",
		startTime: seconds(start),
		duration: seconds(duration),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { text: id },
	};
}

function imageElement({
	id,
	start,
	duration,
}: {
	id: string;
	start: number;
	duration: number;
}): ImageElement {
	return {
		id,
		name: id,
		type: "image",
		mediaId: `media-${id}`,
		startTime: seconds(start),
		duration: seconds(duration),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
	};
}
