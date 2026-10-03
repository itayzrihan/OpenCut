/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- the fixture is shared with canonical Rust integration tests */
import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { TProject } from "@/project/types";
import type { SerializedProject } from "../types";

let stored: unknown;
const unexpected = () => {
	throw new Error("Unexpected media operation in project serialization test");
};
mock.module("@/timeline/scenes", () => ({
	getProjectDurationFromScenes: () => {
		throw new Error("Fixture has explicit duration");
	},
}));
mock.module("@/services/local-drive/client", () => ({
	localDriveRequest: async ({
		operation,
		payload,
	}: {
		operation: string;
		payload?: Record<string, unknown>;
	}) => {
		if (operation === "project.put") {
			stored = JSON.parse(JSON.stringify(payload?.project));
			return;
		}
		if (operation === "project.get") return structuredClone(stored);
		if (operation === "status") return {};
		throw new Error(`Unexpected storage operation: ${operation}`);
	},
	loadLocalFontFile: unexpected,
	localFontUrl: unexpected,
	localMediaUrl: unexpected,
	uploadLocalFont: unexpected,
	uploadLocalMedia: unexpected,
}));

test("project storage roundtrips source packages and existing feature fields", async () => {
	const { StorageService } = await import("../service");
	const fixture = JSON.parse(
		readFileSync(
			new URL(
				"../../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	) as { document: SerializedProject };
	const project: TProject = {
		...fixture.document,
		metadata: {
			...fixture.document.metadata,
			createdAt: new Date(fixture.document.metadata.createdAt),
			updatedAt: new Date(fixture.document.metadata.updatedAt),
		},
		scenes: fixture.document.scenes.map((scene) => ({
			...scene,
			createdAt: new Date(scene.createdAt),
			updatedAt: new Date(scene.updatedAt),
		})),
		hyperframesCompositions: {
			brag: {
				source: {
					entryFile: "index.html",
					files: {
						"index.html": "<div>שלום</div>\r\n<script>const keep = 1;</script>",
					},
					resourceAssetIds: { "footage.mp4": "video-asset" },
				},
				compositionId: "main",
				width: 720,
				height: 1280,
				fps: 30,
				durationSeconds: 6,
			},
		},
	};
	const storage = new StorageService();
	await storage.saveProject({ project });
	const loaded = await storage.loadProject({ id: project.metadata.id });
	expect(loaded?.project).toEqual(project);
	expect(loaded?.project.metadata.createdAt).toBeInstanceOf(Date);
});
