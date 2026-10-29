import { afterEach, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { AiAgentRunOptions } from "../client-agent";
import type { AiToolCall } from "../types";
const revision = "591fa3e028032e6dce56620a20e932e35667e8d8";
const spec = {
	version: 1,
	engine: "earshot",
	bankRevision: revision,
	presetId: "tap",
	seed: 1,
	duration: 0.2,
};
let behavior:
	| "success"
	| "cancel"
	| "conflict"
	| "invalid"
	| "custom"
	| "custom-unread"
	| "custom-other" = "success";
let liveRevision = "r1";
let controller: AbortController;
let renderCount = 0;
mock.module("opencut-wasm", () => ({
	compileAutomaticSoundEffects: ({ planJson }: { planJson: string }) => ({
		valid: behavior !== "invalid",
		sourceJson: "compiled",
		soundCount: JSON.parse(planJson).events.length,
		summary: "Intentional accents",
		error: "Invalid placement",
	}),
}));
mock.module("@/earshot/catalog", () => ({
	EARSHOT_BANK_REVISION: revision,
	EARSHOT_SOUNDS: [
		{ id: "tap", name: "Tap", sourcePath: "bank/tap.py" },
		{ id: "other", name: "Other", sourcePath: "bank/other.py" },
	],
	createEarshotSourceCode: (id: string) =>
		`def render(params, r): return bank.get("${id}")`,
}));
mock.module("@/earshot/types", () => ({
	validateEarshotSpec: (value: unknown) => value,
}));
mock.module("@/earshot/audio", () => ({
	resolveEarshotBuffer: async ({ context }: { context: unknown }) => {
		expect(context).toBeDefined();
		renderCount++;
		if (behavior === "cancel") controller.abort();
		return {
			sampleRate: 48000,
			length: 9600,
			numberOfChannels: 1,
			getChannelData: () => new Float32Array(9600).fill(0.2),
		};
	},
}));
mock.module("@/wasm", () => ({
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120000,
}));
mock.module("@/timeline/scenes", () => ({
	updateSceneInArray: ({ scenes }: { scenes: unknown[] }) => scenes,
}));
mock.module("@/ai/timeline-document-v2", () => ({
	buildTimelineDocumentV2: () => ({
		valid: true,
		formattedText: "original",
		baseRevision: liveRevision,
	}),
	parseTimelineDocumentV2: () => ({
		valid: true,
		value: { tracks: { main: {}, overlay: [], audio: [] }, bookmarks: [] },
	}),
}));
mock.module("@/ai/client-agent", () => ({
	runAiAgent: async ({ executeTool, completionGuard }: AiAgentRunOptions) => {
		const calls: Array<[string, Record<string, unknown>]> = [
			["work.plan", { steps: ["Read and direct one sparse accent"] }],
			["repository.read", { path: "README.md" }],
			["repository.read", { path: "skills/design/SKILL.md" }],

			[
				"sound.preflight",
				{
					planJson: JSON.stringify({
						summary: "Intentional accents",
						events: [
							{
								name: "Tap",
								startTime: 1,
								volume: -18,
								reason: "Beat",
								procedural: behavior.startsWith("custom")
									? {
											...spec,
											sourceCode:
												"def render(params, r): return np.ones(9600) * 0.2",
										}
									: spec,
							},
						],
					}),
				},
			],
		];
		if (behavior === "custom" || behavior === "custom-other")
			calls.splice(3, 0, [
				"catalog.source",
				{ presetId: behavior === "custom" ? "tap" : "other" },
			]);
		for (const [index, [name, args]] of calls.entries()) {
			const call: AiToolCall = { id: `test-${index}`, name, arguments: args };
			await executeTool(call);
		}
		expect(
			await completionGuard?.({ text: "Done", editPlan: null }),
		).toBeNull();
		if (behavior === "conflict") liveRevision = "r2";
		return { status: "completed", text: "Done" };
	},
}));
const { runAutomaticSoundEffects, EARSHOT_AGENT_TOOLS } =
	await import("../automatic-sound-effects");
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalOfflineAudioContext = Object.getOwnPropertyDescriptor(
	globalThis,
	"OfflineAudioContext",
);
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalWindow)
		Object.defineProperty(globalThis, "window", originalWindow);
	else Reflect.deleteProperty(globalThis, "window");
	if (originalOfflineAudioContext)
		Object.defineProperty(
			globalThis,
			"OfflineAudioContext",
			originalOfflineAudioContext,
		);
	else Reflect.deleteProperty(globalThis, "OfflineAudioContext");
});
function setup() {
	liveRevision = "r1";
	controller = new AbortController();
	renderCount = 0;
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		writable: true,
		value: { __opencutAccountId: "account" },
	});
	Object.defineProperty(globalThis, "OfflineAudioContext", {
		configurable: true,
		writable: true,
		value: class {},
	});
	globalThis.fetch = Object.assign(
		mock(async () => Response.json({ revision, content: "pinned reference" })),
		{ preconnect: originalFetch.preconnect },
	);
	const executeTransaction = mock(({ execute }: { execute: () => void }) =>
		execute(),
	);
	const setScenes = mock(() => {});
	const scene = { id: "scene" };
	const project = { metadata: { id: "project" } };
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- This fixture implements only the editor APIs used by the orchestrator.
	const editor = {
		project: { getActive: () => project },
		scenes: {
			getActiveScene: () => scene,
			getScenes: () => [scene],
			setScenes,
		},
		command: { executeTransaction },
		save: { markDirty: mock(() => {}) },
	} as unknown as EditorCore;
	return { editor, executeTransaction, setScenes };
}
describe("automatic procedural sound publication", () => {
	test("preflights PCM and publishes exactly one canonical transaction", async () => {
		behavior = "success";
		const e = setup();
		const result = await runAutomaticSoundEffects({
			editor: e.editor,
			signal: controller.signal,
			onProgress: () => {},
		});
		expect(renderCount).toBe(1);
		expect(e.executeTransaction).toHaveBeenCalledTimes(1);
		expect(e.setScenes).toHaveBeenCalledTimes(1);
		expect(result.soundCount).toBe(1);
	});
	test("cancelled synthesis never publishes", async () => {
		behavior = "cancel";
		const e = setup();
		await expect(
			runAutomaticSoundEffects({
				editor: e.editor,
				signal: controller.signal,
				onProgress: () => {},
			}),
		).rejects.toThrow();
		expect(e.executeTransaction).not.toHaveBeenCalled();
	});
	test("revision conflict never publishes stale source", async () => {
		behavior = "conflict";
		const e = setup();
		await expect(
			runAutomaticSoundEffects({
				editor: e.editor,
				signal: controller.signal,
				onProgress: () => {},
			}),
		).rejects.toThrow("Timeline changed");
		expect(e.executeTransaction).not.toHaveBeenCalled();
	});
	test("compiler rejection never synthesizes or publishes", async () => {
		behavior = "invalid";
		const e = setup();
		await expect(
			runAutomaticSoundEffects({
				editor: e.editor,
				signal: controller.signal,
				onProgress: () => {},
			}),
		).rejects.toThrow("Invalid placement");
		expect(renderCount).toBe(0);
		expect(e.executeTransaction).not.toHaveBeenCalled();
	});
	test("an exact catalog starter unlocks custom source without reading the entire module", async () => {
		behavior = "custom";
		const e = setup();
		await runAutomaticSoundEffects({
			editor: e.editor,
			signal: controller.signal,
			onProgress: () => {},
		});
		expect(renderCount).toBe(1);
		expect(e.executeTransaction).toHaveBeenCalledTimes(1);
	});
	for (const scenario of ["custom-unread", "custom-other"] as const)
		test(`${scenario} cannot preflight unreviewed source`, async () => {
			behavior = scenario;
			const e = setup();
			await expect(
				runAutomaticSoundEffects({
					editor: e.editor,
					signal: controller.signal,
					onProgress: () => {},
				}),
			).rejects.toThrow("this exact preset");
			expect(renderCount).toBe(0);
			expect(e.executeTransaction).not.toHaveBeenCalled();
		});
	test("tool surface is bounded repository, planning, preview and synthesis only", () => {
		expect(EARSHOT_AGENT_TOOLS.map((t) => t.name)).toEqual([
			"repository.list",
			"repository.read",
			"repository.search",
			"catalog.search",
			"catalog.source",
			"work.plan",
			"sound.preflight",
			"preview.capture_frame",
		]);
		expect(
			EARSHOT_AGENT_TOOLS.find((t) => t.name === "sound.preflight")?.readOnly,
		).toBe(false);
	});
});
