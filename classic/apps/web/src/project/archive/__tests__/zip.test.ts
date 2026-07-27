import { describe, expect, test } from "bun:test";
import { createZipBlob, readZipEntries } from "../zip";

describe("project archive ZIP", () => {
	test("round-trips stored entries", async () => {
		const zip = await createZipBlob({
			entries: [
				{ path: "project.json", data: JSON.stringify({ name: "Demo" }) },
				{ path: "media/clip/clip.txt", data: "clip bytes" },
			],
		});

		const entries = await readZipEntries({ blob: zip });
		const projectEntry = entries.get("project.json");
		const clipEntry = entries.get("media/clip/clip.txt");

		if (!projectEntry || !clipEntry) {
			throw new Error("Expected ZIP entries to exist");
		}

		const projectJson = await projectEntry.json<{ name: string }>();
		expect(projectJson).toEqual({ name: "Demo" });
		expect(await clipEntry.text()).toBe("clip bytes");
	});

	test("rejects unsafe paths", async () => {
		await expect(
			createZipBlob({
				entries: [{ path: "../project.json", data: "{}" }],
			}),
		).rejects.toThrow("Invalid ZIP path");
	});
});
