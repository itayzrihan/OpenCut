// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- fixture data is validated by the canonical runtime. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "../canonical-classic-session";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";
import type { PodcastOptions, PodcastVideo } from "@/ai/podcast-types";

test("the web bridge creates, reloads and undoes canonical podcast sequences", async () => {
	const runtime = await createCanonicalTestRuntime();
	const session = new CanonicalClassicSession({
		runtime,
		projectId: "classic-project",
	});
	const original = JSON.parse(
		readFileSync(
			new URL(
				"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	) as CanonicalClassicSnapshot;
	const scene = original.document.scenes[0];
	const caption = scene.tracks.overlay[0];
	if (caption.type !== "text" || !caption.captionSource)
		throw new Error("caption fixture required");
	caption.elements = [];
	caption.captionSource.words = Array.from({ length: 50 }, (_, i) => ({
		text: `word${i}`,
		start: i * 3 + 0.1,
		end: i * 3 + 1.5,
	}));
	scene.tracks.main.elements[0].duration =
		18000000 as (typeof scene.tracks.main.elements)[0]["duration"];
	const video = scene.tracks.main.elements[0];
	if (video.type !== "video") throw new Error("Video fixture required");
	video.retime = { rate: 1 };
	session.attach({ classic: original });
	const source = session.preparePodcast({
		sceneId: scene.id,
		elementIds: ["item-2"],
	});
	expect(source.words).toHaveLength(50);
	const options: PodcastOptions = {
		mode: "teaser",
		minSeconds: 20,
		maxSeconds: 90,
		maxOutputs: 1,
	};
	const videos: PodcastVideo[] = [
		{
			title: "Teaser",
			openingHook: "Strong opener",
			endingHook: "An open question",
			confidence: 0.8,
			alternatives: [
				{
					label: "Whole clauses",
					reason: "Coherence",
					parts: [
						{ firstWord: 20, lastWord: 25 },
						{ firstWord: 5, lastWord: 10 },
					],
				},
			],
		},
	];
	const input = {
		sceneId: scene.id,
		elementIds: ["item-2"],
		expectedRevision: source.revision,
		options,
		videos,
	};
	session.podcast({ ...input, review: true });
	expect(session.read()).toEqual(original);
	session.begin();
	session.podcast(input);
	session.commit({ label: "Create podcast extracts", hostContext: {} });
	const assembled = session.read();
	expect(assembled.document.scenes).toHaveLength(3);
	const result = assembled.document.scenes[2];
	expect(result.podcastExtract?.options.mode).toBe("teaser");
	expect(result.takeAssembly?.selectionOnly).toBe(true);
	expect(assembled.document.scenes[0]).toEqual(original.document.scenes[0]);
	const reopened = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	reopened.restore(session.archive());
	expect(reopened.read().document.scenes[2].podcastExtract).toEqual(
		result.podcastExtract,
	);
	reopened.undo();
	expect(reopened.read()).toEqual(original);
	reopened.redo();
	expect(reopened.read()).toEqual(assembled);
	session.dispose();
	reopened.dispose();
});
