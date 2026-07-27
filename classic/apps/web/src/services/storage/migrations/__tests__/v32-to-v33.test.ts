import { describe, expect, test } from "bun:test";
import { transformProjectV32ToV33 } from "../transformers/v32-to-v33";
import { asRecord, asRecordArray } from "./helpers";

describe("V32 to V33 Migration", () => {
	test("marks old URL-only library audio as remote-compatible", () => {
		const result = transformProjectV32ToV33({
			project: {
				id: "project-v32-library-audio",
				version: 32,
				scenes: [
					{
						tracks: {
							overlay: [],
							main: { id: "main", elements: [] },
							audio: [
								{
									id: "audio-track",
									elements: [
										{
											id: "remote-audio",
											type: "audio",
											sourceType: "library",
											sourceUrl: "https://example.com/sfx.mp3",
										},
									],
								},
							],
						},
					},
				],
			},
		});

		expect(result.skipped).toBe(false);
		expect(result.project.version).toBe(33);
		const scene = asRecordArray(result.project.scenes)[0];
		const tracks = asRecord(scene.tracks);
		const audioTrack = asRecordArray(tracks.audio)[0];
		const audioElement = asRecordArray(audioTrack.elements)[0];
		expect(audioElement.librarySourceType).toBe("remote");
		expect(audioElement.sourceUrl).toBe("https://example.com/sfx.mp3");
	});

	test("marks shared library audio by stable asset id", () => {
		const result = transformProjectV32ToV33({
			project: {
				id: "project-v32-shared-audio",
				version: 32,
				scenes: [
					{
						tracks: {
							overlay: [],
							main: { id: "main", elements: [] },
							audio: [
								{
									id: "audio-track",
									elements: [
										{
											id: "shared-audio",
											type: "audio",
											sourceType: "library",
											libraryAssetId: "asset-1",
										},
									],
								},
							],
						},
					},
				],
			},
		});

		const scene = asRecordArray(result.project.scenes)[0];
		const tracks = asRecord(scene.tracks);
		const audioTrack = asRecordArray(tracks.audio)[0];
		const audioElement = asRecordArray(audioTrack.elements)[0];
		expect(audioElement.librarySourceType).toBe("shared");
		expect(audioElement.libraryAssetId).toBe("asset-1");
	});
});
