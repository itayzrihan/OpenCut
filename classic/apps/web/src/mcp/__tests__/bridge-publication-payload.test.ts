import { expect, test } from "bun:test";
import { bridgePublication } from "../bridge-publication";
const metadata = {
	projectId: "p",
	projectName: "P",
	revision: 1,
	dirty: false,
	playback: { position: 17 },
	selection: [],
	ui: {},
};
test("hundreds of unchanged heartbeats never materialize or serialize a large document", () => {
	let reads = 0;
	const readDocument = () => {
		reads++;
		return { timeline: { text: "x".repeat(8 * 1024 * 1024) }, tools: [] };
	};
	const full = bridgePublication({
		sessionId: "tab",
		metadata,
		documentDirty: true,
		readDocument,
	});
	expect(JSON.stringify(full.payload).length).toBeGreaterThan(8 * 1024 * 1024);
	for (let i = 0; i < 500; i++) {
		const small = bridgePublication({
			sessionId: "tab",
			metadata: { ...metadata, revision: i + 1 },
			documentDirty: false,
			acknowledged: { projectId: "p", revision: i + 1 },
			readDocument,
		});
		expect(small.method).toBe("POST");
		expect(JSON.stringify(small.payload).length).toBeLessThan(1024);
		expect("timeline" in small.payload).toBe(false);
	}
	expect(reads).toBe(1);
});
test("edits, project switches and lost/restarted peers require a fresh full canonical projection", () => {
	for (const input of [
		{ documentDirty: true, acknowledged: { projectId: "p", revision: 1 } },
		{ documentDirty: false, acknowledged: { projectId: "other", revision: 1 } },
		{ documentDirty: false, acknowledged: undefined },
	]) {
		expect(
			bridgePublication({
				sessionId: "tab",
				metadata,
				...input,
				readDocument: () => ({ timeline: { fresh: true } }),
			}).method,
		).toBe("PUT");
	}
});
