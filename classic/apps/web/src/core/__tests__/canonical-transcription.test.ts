import { mediaTime } from "@/wasm/media-time";
// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "../canonical-classic-session";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";
import { DEFAULTS } from "@/timeline/defaults";
import { DEFAULT_CAPTION_LAYOUT } from "@/subtitles/caption-layout";

test("browser runtime archives partial captions and continues after split, move and reopen", async () => {
	const create = async () =>
		new CanonicalClassicSession({
			runtime: await createCanonicalTestRuntime(),
			projectId: "classic-project",
		});
	const session = await create();
	const original = JSON.parse(
		readFileSync(
			new URL(
				"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	) as CanonicalClassicSnapshot;
	const clip = original.document.scenes[0].tracks.main.elements[0];
	Object.assign(clip, {
		duration: 180 * 120000,
		trimStart: 0,
		trimEnd: 0,
		retime: { rate: 1 },
		params: { ...clip.params, audioSyncOffset: 0 },
	});
	original.mediaAssets[0].duration = 180;
	session.attach({ classic: original });
	const change = ({
		s,
		change,
	}: {
		s: CanonicalClassicSession;
		change: unknown;
	}) =>
		s.invokeControl({
			capabilityId: "transcription.classic.edit",
			input: { jobId: "test-job", change },
		});
	change({
		s: session,
		change: {
			type: "start",
			sceneId: "main-scene",
			language: "he",
			settings: DEFAULT_CAPTION_LAYOUT,
			defaults: DEFAULTS.text,
			totalDuration: 180 * 120000,
		},
	});
	const chunk = (index: number) => ({
		type: "append",
		index,
		words: [
			{ text: `word-${index}`, start: index * 60 + 1, end: index * 60 + 2 },
		],
	});
	change({ s: session, change: chunk(0) });
	expect(
		session.read().document.transcriptionJobs?.[0].chunks["0"],
	).toHaveLength(1);
	expect(
		session
			.read()
			.document.scenes[0].tracks.overlay.some(
				(t) =>
					t.type === "text" &&
					t.captionSource?.sourceId === "test-job" &&
					t.elements.length > 0,
			),
	).toBe(true);
	session.invokeControl({
		capabilityId: "timeline.classic.elements.split",
		input: {
			sceneId: "main-scene",
			elements: [{ trackId: "video-track", elementId: clip.id }],
			splitTime: 60 * 120000,
		},
	});
	const right = session
		.read()
		.document.scenes[0].tracks.main.elements.find(
			(e) => e.startTime === 60 * 120000,
		)!;
	session.invokeControl({
		capabilityId: "timeline.classic.elements.move",
		input: {
			sceneId: "main-scene",
			moves: [
				{
					sourceTrackId: "video-track",
					elementId: right.id,
					targetTrackId: "video-track",
					newStartTime: 80 * 120000,
				},
			],
		},
	});
	const restored = await create();
	restored.restore(session.archive());
	change({ s: restored, change: chunk(1) });
	change({ s: restored, change: chunk(2) });
	const after = restored.read();
	expect(after.document.transcriptionJobs?.[0].status).toBe("complete");
	const words = after.document.scenes[0].tracks.overlay.flatMap((t) =>
		t.type === "text" && t.captionSource?.sourceId === "test-job"
			? t.captionSource.words
			: [],
	);
	expect(words.some((w) => w.text === "word-1" && w.start === 81)).toBe(true);
	expect(words.some((w) => w.text === "word-2" && w.start === 141)).toBe(true);
	change({ s: restored, change: chunk(1) });
	expect(restored.read()).toEqual(after);
	session.dispose();
	restored.dispose();
});

test('SRT is a durable canonical transcript and external engine preference survives reopen',async()=>{
 const session=new CanonicalClassicSession({runtime:await createCanonicalTestRuntime(),projectId:'classic-project'});
 const original=JSON.parse(readFileSync(new URL('../../../../../../crates/editor-api/tests/fixtures/classic-project.json',import.meta.url),'utf8')) as CanonicalClassicSnapshot;
 session.attach({classic:original});
 session.invokeControl({capabilityId:'transcription.classic.edit',input:{jobId:'settings',change:{type:'setEngine',engine:'external'}}});
 session.invokeControl({capabilityId:'transcription.classic.edit',input:{jobId:'srt-source',change:{type:'importSrt',sceneId:'main-scene',text:'1\n00:00:01,500 --> 00:00:04,500\nשלום עולם\n\n2\n00:00:05,000 --> 00:00:07,000\nA second cue',settings:DEFAULT_CAPTION_LAYOUT,defaults:DEFAULTS.text}}});
 const restored=new CanonicalClassicSession({runtime:await createCanonicalTestRuntime(),projectId:'classic-project'});restored.restore(session.archive());
 const document=restored.read().document;
 expect(document.transcriptionEngine).toBe('external');
 const track=document.scenes[0].tracks.overlay.find(t=>t.type==='text'&&t.captionSource?.sourceId==='srt-source');
 expect(track?.elements).toHaveLength(2);expect(track?.elements[0].startTime).toBe(mediaTime({ ticks: 180000 }));
 if(track?.type==='text')expect(track.captionSource?.words.map(w=>w.text)).toEqual(['שלום','עולם','A','second','cue']);
 expect(JSON.stringify(document)).not.toContain('apiKey');session.dispose();restored.dispose();
});
