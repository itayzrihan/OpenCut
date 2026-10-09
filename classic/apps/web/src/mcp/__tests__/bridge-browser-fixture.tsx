import { mockFetch } from "@/test-support/mock-fetch";
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- This isolated browser fixture supplies the bridge's host boundaries. */

const projectListeners = new Set<() => void>();
const sceneListeners = new Set<() => void>();
const timelineListeners = new Set<() => void>();
const playbackListeners = new Set<() => void>();
const selectionListeners = new Set<() => void>();
const subscribe = (listeners: Set<() => void>) => (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
let project: {
	metadata: { id: string; name: string };
	settings: { width: number };
} | null = {
	metadata: { id: "first", name: "First project" },
	settings: { width: 1920 },
};
let scene = { id: "main", name: "Main scene", title: "Original title" };
let position = 0;
let selected = "";
let documentBuilds = 0;
let now = 0;
let timerId = 0;
const timers = new Map<
	number,
	{ at: number; interval: number; callback: () => void }
>();
const settle = async () => {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};
// eslint-disable-next-line opencut/prefer-object-params -- Match the browser timer API.
window.setTimeout = ((callback: () => void, delay = 0) => {
	const id = ++timerId;
	timers.set(id, { at: now + delay, interval: 0, callback });
	return id;
}) as typeof window.setTimeout;
// eslint-disable-next-line opencut/prefer-object-params -- Match the browser timer API.
window.setInterval = ((callback: () => void, delay = 0) => {
	const id = ++timerId;
	timers.set(id, { at: now + delay, interval: delay, callback });
	return id;
}) as typeof window.setInterval;
window.clearTimeout = window.clearInterval = (id) => {
	if (typeof id === "number") timers.delete(id);
};

type Publication = {
	revision: number;
	projectId: string;
	projectName: string;
	timeline: { settings: { width: number }; scene: typeof scene };
	playback: { positionSeconds: number };
	selection: string;
};
const publications: Publication[] = [];
let deletes = 0;
window.fetch = mockFetch(async (input, options) => {
	const url = String(input);
	if (url === "/api/mcp-bridge/state") {
		publications.push(JSON.parse(String(options?.body)));
		return Response.json({ ok: true });
	}
	if (url.startsWith("/api/mcp-bridge/commands/"))
		return Response.json({ commands: [] });
	if (url.startsWith("/api/mcp-bridge/session/")) {
		deletes++;
		return Response.json({});
	}
	throw new Error(`Unexpected fixture request: ${url}`);
});

export const mediaTimeToSeconds = ({ time }: { time: number }) => time;
export const applyAiEditPlan = () => {
	throw new Error("Unexpected edit command");
};
export const createTimelineToolDefinitions = () => [];
export const createTimelineToolSessionState = () => ({});
export const createTimelineToolRuntime = async () => ({ tools: [] });
export const backgroundRemovalService = {
	getStatus: () => ({}),
	subscribe: () => () => {},
};
export const buildTimelineDocumentV2 = ({
	project: currentProject,
	scene: currentScene,
}: {
	project: typeof project;
	scene: typeof scene;
}) => {
	documentBuilds++;
	return {
		valid: true,
		formattedText: JSON.stringify({
			settings: currentProject?.settings,
			scene: currentScene,
		}),
	};
};
export const editor = {
	project: {
		getActiveOrNull: () => project,
		subscribe: subscribe(projectListeners),
	},
	scenes: {
		getActiveSceneOrNull: () => scene,
		subscribe: subscribe(sceneListeners),
	},
	timeline: {
		getTotalDuration: () => 100,
		subscribe: subscribe(timelineListeners),
	},
	playback: {
		getIsPlaying: () => false,
		getCurrentTime: () => position,
		getVolume: () => 1,
		isMuted: () => false,
		subscribe: subscribe(playbackListeners),
	},
	media: { subscribe: () => () => {} },
	selection: {
		getSnapshot: () => selected,
		subscribe: subscribe(selectionListeners),
	},
	save: { getIsDirty: () => false },
};
const notify = (listeners: Set<() => void>) => {
	for (const listener of listeners) listener();
};
export const controls = {
	advance: async (milliseconds: number) => {
		await settle();
		const until = now + milliseconds;
		for (;;) {
			const next = [...timers.entries()]
				.filter(([, timer]) => timer.at <= until)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			const [id, timer] = next;
			now = timer.at;
			if (timer.interval) timer.at += timer.interval;
			else timers.delete(id);
			timer.callback();
			await settle();
		}
		now = until;
		await settle();
	},
	exportProgress: () => notify(projectListeners),
	rename: () => {
		project = {
			...project!,
			metadata: { ...project!.metadata, name: "Renamed project" },
		};
		notify(projectListeners);
	},
	settings: () => {
		project = { ...project!, settings: { width: 1280 } };
		notify(projectListeners);
	},
	timelineEdit: () => {
		scene = { ...scene, title: "Edited title" };
		notify(timelineListeners);
	},
	changeScene: () => {
		scene = { ...scene, id: "second-scene", name: "Second scene" };
		notify(sceneListeners);
	},
	seek: () => {
		position = 17;
		notify(playbackListeners);
	},
	select: () => {
		selected = "clip";
		notify(selectionListeners);
	},
	closeProject: () => {
		project = null;
		notify(projectListeners);
	},
	switchProject: () => {
		project = {
			metadata: { id: "second", name: "Second project" },
			settings: { width: 640 },
		};
		notify(projectListeners);
	},
	unmount: () => {},
	read: () => ({
		publications,
		documentBuilds,
		deletes,
		listeners: [
			projectListeners,
			sceneListeners,
			timelineListeners,
			playbackListeners,
			selectionListeners,
		].reduce((sum, set) => sum + set.size, 0),
	}),
};
declare global {
	interface Window {
		bridgeFixture: typeof controls;
	}
}
window.bridgeFixture = controls;
