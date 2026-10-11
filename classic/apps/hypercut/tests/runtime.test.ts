import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RuntimeSession, type Runtime } from "../experiments/classic-projection/runtime-session";
import { TICKS, tracksOf, reference, trackForStudioLane } from "../experiments/classic-projection/model";
import { compositionHTML } from "../experiments/classic-projection/composition";
import * as glue from "../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js";
const bytes = await readFile(
	new URL(
		"../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.wasm",
		import.meta.url,
	),
);
const { instance } = await WebAssembly.instantiate(
	new Uint8Array(bytes).buffer,
	{ "./opencut_editor_runtime_wasm_bg.js": glue },
);
glue.__wbg_set_wasm(instance.exports);
(instance.exports.__wbindgen_start as () => void)();
function session() {
	const s = new RuntimeSession(
		new glue.CanonicalEditorRuntime() as unknown as Runtime,
		"hypercut-test",
	);
	s.open("HyperCut test");
	return s;
}
function invoke(s: RuntimeSession, id: string, input: Record<string, unknown>) {
	return s.invoke(id, input, s.snapshot().revision);
}
function insert(s: RuntimeSession) {
	return invoke(s, "timeline.classic.elements.insert", {
		sceneId: "main-scene",
		clips: [
			{
				element: {
					type: "text",
					name: "שלום עולם",
					startTime: 0,
					duration: 10 * TICKS,
					params: { content: "שלום <script>bad()</script>", fontSize: 80 },
				},
				placement: { mode: "auto" },
			},
		],
	});
}
test("canonical create, insert, split, ripple-delete, history and reopen preserve new project", () => {
	const s = session();
	insert(s);
	let clips = tracksOf(s.snapshot()).flatMap((t) => t.elements);
	assert.equal(clips.length, 1);
	const ref = reference(s.snapshot(), clips[0].id);
	invoke(s, "timeline.classic.elements.split", {
		sceneId: "main-scene",
		elements: [ref],
		splitTime: 4 * TICKS,
		retainSide: "both",
	});
	clips = tracksOf(s.snapshot()).flatMap((t) => t.elements);
	assert.equal(clips.length, 2);
	assert.equal(clips[1].startTime, 4 * TICKS);
	invoke(s, "timeline.classic.remove", {
		sceneId: "main-scene",
		removal: { type: "elements", elements: [ref], ripple: true },
	});
	clips = tracksOf(s.snapshot()).flatMap((t) => t.elements);
	assert.equal(clips.length, 1);
	assert.equal(clips[0].startTime, 0);
	assert.equal(clips[0].duration, 6 * TICKS);
	invoke(s, "history.undo", {});
	assert.equal(tracksOf(s.snapshot()).flatMap((t) => t.elements).length, 2);
	const archive = s.archive();
	const restored = new RuntimeSession(
		new glue.CanonicalEditorRuntime() as unknown as Runtime,
		"hypercut-test",
	);
	restored.open("ignored", archive);
	assert.deepEqual(
		restored.snapshot().project.classic,
		s.snapshot().project.classic,
	);
	assert.equal(restored.view().history.canRedo, true);
	invoke(restored, "history.redo", {});
	assert.equal(
		tracksOf(restored.snapshot()).flatMap((t) => t.elements).length,
		1,
	);
	s.runtime.free();
	restored.runtime.free();
});
test("stale edits are rejected atomically; projection escapes authored HTML", () => {
	const s = session();
	const revision = s.snapshot().revision;
	insert(s);
	const before = s.snapshot();
	assert.throws(() =>
		s.invoke(
			"timeline.classic.elements.insert",
			{ sceneId: "main-scene", clips: [] },
			revision,
		),
	);
	assert.deepEqual(s.snapshot(), before);
	const html = compositionHTML(before, new Map(), "http://127.0.0.1:3220");
	assert.ok(html.includes("&lt;script&gt;bad()&lt;/script&gt;"));
	assert.ok(!html.includes("<script>bad()"));
	s.runtime.free();
});
test("media registry and clip insertion retain source windows in HyperFrames projection", () => {
	const s = session();
	invoke(s, "media.classic.register", {
		assets: [
			{
				id: "media",
				name: "test video",
				type: "video",
				duration: 12,
				width: 1920,
				height: 1080,
			},
		],
	});
	invoke(s, "timeline.classic.elements.insert", {
		sceneId: "main-scene",
		clips: [
			{
				element: {
					type: "video",
					name: "test video",
					mediaId: "media",
					startTime: 2 * TICKS,
					duration: 5 * TICKS,
					trimStart: 3 * TICKS,
					trimEnd: 4 * TICKS,
					params: {},
				},
				placement: { mode: "explicit", trackId: "main-video" },
			},
		],
	});
	const html = compositionHTML(
		s.snapshot(),
		new Map([["media", "blob:owned"]]),
		"http://127.0.0.1:3220",
	);
	assert.ok(html.includes('data-media-start="3"'), html);
	assert.ok(html.includes('data-duration="5"'), html);
	assert.ok(html.includes('data-start="0"'), html); // Main-track insert is canonically gapless.
	s.runtime.free();
});

test("Studio source-qualified selection resolves to canonical clip identity", () => {
	const s = session();
	insert(s);
	const clip = tracksOf(s.snapshot()).flatMap((t) => t.elements)[0];
	assert.deepEqual(
		reference(s.snapshot(), "index.html#" + clip.id),
		reference(s.snapshot(), clip.id),
	);
	assert.throws(() => reference(s.snapshot(), "foreign.html#" + clip.id));
	s.runtime.free();
});

test("normalized Studio lanes resolve canonical track identity after empty rows disappear", () => {
	const s = session();
	insert(s);
	const clip = tracksOf(s.snapshot()).flatMap((t) => t.elements)[0];
	const ref = reference(s.snapshot(), clip.id);
	assert.equal(
		trackForStudioLane(s.snapshot(), 0, [
			{ id: "index.html#" + clip.id, track: 0 },
		]),
		ref.trackId,
	);
	assert.equal(
		trackForStudioLane(s.snapshot(), 2, [{ id: clip.id, track: 0 }]),
		undefined,
	);
	s.runtime.free();
});
