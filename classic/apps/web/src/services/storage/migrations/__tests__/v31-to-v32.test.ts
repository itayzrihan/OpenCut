import { describe, expect, test } from "bun:test";
import { transformProjectV31ToV32 } from "../transformers/v31-to-v32";
import { asRecord, asRecordArray } from "./helpers";

describe("V31 to V32 Migration", () => {
	test("adds explicit track order using legacy display order", () => {
		const result = transformProjectV31ToV32({
			project: {
				id: "project-v31-order",
				version: 31,
				scenes: [
					{
						tracks: {
							overlay: [{ id: "text-1" }, { id: "effect-1" }],
							main: { id: "main" },
							audio: [{ id: "audio-1" }],
						},
					},
				],
			},
		});

		expect(result.skipped).toBe(false);
		expect(result.project.version).toBe(32);
		const scene = asRecordArray(result.project.scenes)[0];
		const tracks = asRecord(scene.tracks);
		expect(tracks.order).toEqual(["text-1", "effect-1", "main", "audio-1"]);
	});

	test("skips a project that is already v32", () => {
		const project = { id: "p1", version: 32, scenes: [] };
		const result = transformProjectV31ToV32({ project });
		expect(result.skipped).toBe(true);
		expect(result.reason).toBe("already v32");
		expect(result.project).toBe(project);
	});
});
