import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
type Fixture = {
	podcastExtract: {
		title: string;
		sourceSceneId: string;
		openingHook: string;
		endingHook: string;
		options: { mode: "teleprompter" };
	};
	takeAssembly: {
		plan: {
			groups: {
				label: string;
				selected: number;
				alternatives: { label: string; reason: string }[];
			}[];
		};
	};
};
let scene: Fixture | null = null;
let selection: { elementId: string }[] = [];
const editor = {
	command: {
		podcastScope: () => ({ referenceRegions: [] }),
		selectSmartTake: () => {},
	},
};
mock.module("@/editor/use-editor", () => ({
	useEditor: () => editor,
	useEditorSelection: (
		f: (value: {
			selection: { getSelectedElements: () => typeof selection };
		}) => unknown,
	) => f({ selection: { getSelectedElements: () => selection } }),
	useEditorTimelineScenes: (
		f: (value: {
			scenes: { getActiveSceneOrNull: () => typeof scene };
		}) => unknown,
	) => f({ scenes: { getActiveSceneOrNull: () => scene } }),
}));
mock.module("../podcast-task", () => ({
	getPodcastTask: () => ({
		subscribe: () => () => {},
		getSnapshot: () => ({ status: "idle" }),
		cancel: () => {},
		start: () => {},
	}),
}));
const { PodcastControls } = await import("../components/podcast-controls");
test("teleprompter action follows chronological action and communicates full-timeline/strict-selection reference", () => {
	const html = renderToStaticMarkup(<PodcastControls />);
	expect(html.indexOf("קטעים לפי סדר המקור")).toBeLessThan(
		html.indexOf("חיתוכי טלפרומפטר"),
	);
	expect(html).toContain("כל הטיימליין הפעיל");
	selection = [{ elementId: "selected" }];
	expect(renderToStaticMarkup(<PodcastControls />)).toContain(
		"טווחי הקליפים המסומנים בלבד",
	);
	selection = [];
});
test("generated teleprompter scene exposes lazy per-sentence take choices and source navigation", () => {
	scene = {
		podcastExtract: {
			title: "תסריט",
			sourceSceneId: "source",
			openingHook: "שלום",
			endingHook: "תודה",
			options: { mode: "teleprompter" },
		},
		takeAssembly: {
			plan: {
				groups: [
					{
						label: "משפט הפתיחה",
						selected: 1,
						alternatives: [
							{ label: "ראשון", reason: "מלא" },
							{ label: "שני", reason: "ניסוח שלם" },
						],
					},
				],
			},
		},
	};
	const html = renderToStaticMarkup(<PodcastControls />);
	expect(html).toContain("טייקים חלופיים לפי משפט (1)");
	expect(html).not.toContain("<select");
	expect(html).toContain("פתח את סצנת המקור");
});
