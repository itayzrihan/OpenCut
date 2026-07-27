import { describe, expect, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import type { MediaTime } from "@/wasm";
import { applySourceEdits } from "@/ai/source-edits";
import {
	diffTimelineSource,
	parseTimelineSource,
	serializeTimelineSource,
} from "@/ai/timeline-source";

const t = (time: number) => time as MediaTime;

const tracks: SceneTracks = {
	overlay: [
		{
			id: "track-text-1234567890",
			name: "Text",
			type: "text",
			hidden: false,
			elements: [
				{
					id: "element-text-1234567890",
					type: "text",
					name: "Caption",
					startTime: t(120_000),
					duration: t(240_000),
					trimStart: t(0),
					trimEnd: t(0),
					params: {
						content: "Hello",
						fontSize: 80,
					},
				},
			],
		},
	],
	main: {
		id: "main-track-1234567890",
		name: "Main",
		type: "video",
		hidden: false,
		muted: false,
		elements: [],
	},
	audio: [],
};

function getLine({
	source,
	prefix,
	contains,
}: {
	source: string;
	prefix: string;
	contains: string;
}): string {
	const line = source
		.split("\n")
		.find(
			(candidate) =>
				candidate.startsWith(prefix) && candidate.includes(contains),
		);
	if (!line) {
		throw new Error(`Could not find ${prefix} line containing ${contains}`);
	}
	return line;
}

describe("timeline source edits", () => {
	test("diffs an exact text line replacement into an update_element operation", () => {
		const source = serializeTimelineSource({ tracks });
		const elementLine = getLine({
			source: source.text,
			prefix: "el ",
			contains: '"type":"text"',
		});
		const editedText = applySourceEdits({
			content: source.text,
			edits: [
				{
					oldText: elementLine,
					newText: elementLine.replace(
						'"text":"Hello"',
						'"text":"Hello faster"',
					),
				},
			],
		});

		const diff = diffTimelineSource({
			before: parseTimelineSource({ text: source.text }),
			after: parseTimelineSource({ text: editedText }),
			idMap: source.idMap,
		});

		expect(diff.errors).toEqual([]);
		expect(diff.operations).toEqual([
			{
				type: "update_element",
				trackId: "track-text-1234567890",
				elementId: "element-text-1234567890",
				patch: { params: { content: "Hello faster" } },
			},
		]);
	});

	test("diffs a new element line into an insert_text_element operation", () => {
		const source = serializeTimelineSource({ tracks });
		const trackLine = getLine({
			source: source.text,
			prefix: "track ",
			contains: '"kind":"text"',
		});
		const track = JSON.parse(trackLine.slice("track ".length)) as {
			id: string;
		};
		const newElementLine = `el {"id":"new","track":"${track.id}","type":"text","at":2,"dur":1.25,"name":"Hook","text":"Watch this"}`;
		const editedText = applySourceEdits({
			content: source.text,
			edits: [
				{
					oldText: `${trackLine}\n`,
					newText: `${trackLine}\n${newElementLine}\n`,
				},
			],
		});

		const diff = diffTimelineSource({
			before: parseTimelineSource({ text: source.text }),
			after: parseTimelineSource({ text: editedText }),
			idMap: source.idMap,
		});

		expect(diff.errors).toEqual([]);
		expect(diff.operations).toEqual([
			{
				type: "insert_text_element",
				trackId: "track-text-1234567890",
				content: "Watch this",
				name: "Hook",
				startTime: t(240_000),
				duration: t(150_000),
			},
		]);
	});

	test("uses fuzzy matching only to locate the original source span", () => {
		const source = 'el {"id":"a","text":"Fast - clean"}\n';
		const editedText = applySourceEdits({
			content: source,
			edits: [
				{
					oldText: 'el {"id":"a","text":"Fast \u2013 clean"}',
					newText: 'el {"id":"a","text":"Fast and clean"}',
				},
			],
		});

		expect(editedText).toBe('el {"id":"a","text":"Fast and clean"}\n');
	});
});
