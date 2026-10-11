// Read-only transport projection of the canonical Rust document. Times are exact ticks.
export const TICKS = 120_000;
export interface Clip {
	id: string;
	type: string;
	name: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	mediaId?: string;
	sourceDuration?: number;
	params: Record<string, unknown>;
	retime?: { rate: number };
}
export interface Track {
	id: string;
	name: string;
	type: string;
	hidden?: boolean;
	muted?: boolean;
	elements: Clip[];
}
export interface Scene {
	id: string;
	name: string;
	tracks: { main: Track; overlay: Track[]; audio: Track[]; order: string[] };
	bookmarks: unknown[];
}
export interface Media {
	id: string;
	name: string;
	type: "video" | "audio" | "image";
	duration?: number;
	width?: number;
	height?: number;
	size?: number;
}
export interface Classic {
	document: {
		metadata: { id: string; name: string };
		settings: {
			fps: { numerator: number; denominator: number };
			canvasSize: { width: number; height: number };
			background: { type: string; color?: string };
		};
		currentSceneId: string;
		scenes: Scene[];
	};
	mediaAssets: Media[];
}
export interface Snapshot {
	revision: number;
	project: { id: string; classic: Classic };
}
export interface SessionView {
	snapshot: Snapshot;
	history: { canUndo: boolean; canRedo: boolean };
	persisted: boolean;
}
export function sceneOf(s: Snapshot): Scene {
	return s.project.classic.document.scenes.find(
		(scn) => scn.id === s.project.classic.document.currentSceneId,
	)!;
}
export function tracksOf(s: Snapshot): Track[] {
	const t = sceneOf(s).tracks;
	const all = [...t.overlay, t.main, ...t.audio];
	return [...all].sort((a, b) => t.order.indexOf(a.id) - t.order.indexOf(b.id));
}
export function canonicalClipId(id: string): string {
	return id.startsWith("index.html#") ? id.slice("index.html#".length) : id;
}
export function reference(s: Snapshot, studioId: string) {
	const id = canonicalClipId(studioId);
	const track = tracksOf(s).find((t) => t.elements.some((e) => e.id === id));
	if (!track) throw Error("This clip is no longer present.");
	return { trackId: track.id, elementId: id };
}
export function emptyProject(id: string, name: string) {
	const date = new Date().toISOString();
	return {
		document: {
			metadata: { id, name, duration: 0, createdAt: date, updatedAt: date },
			settings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1920, height: 1080 },
				canvasSizeMode: "custom",
				background: { type: "color", color: "#000000" },
			},
			version: 33,
			currentSceneId: "main-scene",
			scenes: [
				{
					id: "main-scene",
					name: "Main",
					isMain: true,
					createdAt: date,
					updatedAt: date,
					bookmarks: [],
					tracks: {
						main: {
							id: "main-video",
							name: "Video",
							type: "video",
							hidden: false,
							muted: false,
							elements: [],
						},
						overlay: [],
						audio: [],
						order: ["main-video"],
					},
				},
			],
		},
		mediaAssets: [],
	};
}

/** Studio omits empty rows and normalizes authored lane numbers. Resolve identity, never assume array positions match. */
export function trackForStudioLane(
	snapshot: Snapshot,
	lane: number,
	elements: readonly { id: string; track: number }[],
): string | undefined {
	const element = elements.find((e) => e.track === lane);
	return element ? reference(snapshot, element.id).trackId : undefined;
}
