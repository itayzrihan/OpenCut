import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifact, fileBytes } from "./store";
import { probeReference } from "./probe";
import { prepare } from "./provider";
test("original speech timing is measured without modifying bytes and cannot be truncated", async () => {
	const root = await mkdtemp(join(tmpdir(), "director-probe-"));
	try {
		const count = 16000 * 9.25 * 2,
			bytes = Buffer.alloc(44 + count);
		bytes.write("RIFF");
		bytes.writeUInt32LE(36 + count, 4);
		bytes.write("WAVEfmt ", 8);
		bytes.writeUInt32LE(16, 16);
		bytes.writeUInt16LE(1, 20);
		bytes.writeUInt16LE(1, 22);
		bytes.writeUInt32LE(16000, 24);
		bytes.writeUInt32LE(32000, 28);
		bytes.writeUInt16LE(2, 32);
		bytes.writeUInt16LE(16, 34);
		bytes.write("data", 36);
		bytes.writeUInt32LE(count, 40);
		const audio = await artifact({
			root,
			projectId: "p",
			name: "voice.wav",
			mime: "audio/wav",
			bytes,
		});
		expect(await probeReference({ root, projectId: "p", id: audio.id })).toBe(
			9.25,
		);
		expect(
			(
				await fileBytes({ root, projectId: "p", fileId: audio.id })
			).bytes.equals(bytes),
		).toBe(true);
		await expect(
			prepare({
				root,
				raw: {
					projectId: "p",
					kind: "video",
					model: "bytedance/seedance-2.5",
					prompt: "Preserve the full original spoken narration",
					duration: 8,
					resolution: "480p",
					aspectRatio: "9:16",
					referenceIds: [audio.id],
				},
				referenceUrl: async () => "",
				net: async () => {
					throw new Error("Must not reach network");
				},
			}),
		).rejects.toThrow("truncate");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
