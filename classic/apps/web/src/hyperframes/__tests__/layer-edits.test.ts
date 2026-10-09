import { expect, test } from "bun:test";
import { HyperframesRenderClient } from "../render-client";
import {
	hyperframesVisualKey,
	hyperframesLayerEditsScript,
} from "../layer-edits";
import { composition, renderFixture } from "./render-client-fixture";

test("visual identity and captured frames stay separate for edited occurrences of one source", async () => {
	const fixture = renderFixture();
	const client = new HyperframesRenderClient("project-a");
	const source = composition();
	const layerEdits = {
		sourceFingerprint: "source",
		manifestFingerprint: "manifest",
		opacity: { "dom/1/0": 0.5 },
	};
	try {
		const original = await client.openLivePreview({ composition: source });
		const edited = await client.openLivePreview({
			composition: source,
			layerEdits,
		});
		const duplicate = await client.openLivePreview({
			composition: source,
			layerEdits: structuredClone(layerEdits),
		});
		expect(original.url).not.toBe(edited.url);
		expect(duplicate.url).toBe(edited.url);
		expect(fixture.count("open")).toBe(2);
		expect(
			fixture.calls.find((call) => call.action === "open"),
		).not.toHaveProperty("layerEdits");
		expect(
			fixture.calls.filter((call) => call.action === "open")[1],
		).toHaveProperty("layerEdits", layerEdits);
		const draw = (edits?: typeof layerEdits) =>
			client.renderTo({
				composition: source,
				layerEdits: edits,
				target: fixture.target,
				timeSeconds: 1,
			});
		await draw();
		await draw(layerEdits);
		await draw(structuredClone(layerEdits));
		await draw();
		expect(fixture.count("capture")).toBe(2);
		expect(fixture.draws[0]).not.toBe(fixture.draws[1]);
		expect(fixture.draws[1]).toBe(fixture.draws[2]);
		expect(fixture.draws[0]).toBe(fixture.draws[3]);
		expect(hyperframesVisualKey({ source: source.source })).toBe(source.source);
		const key = hyperframesVisualKey({ source: source.source, layerEdits });
		expect(
			hyperframesVisualKey({
				source: source.source,
				layerEdits: structuredClone(layerEdits),
			}),
		).toBe(key);
		expect(
			hyperframesVisualKey({
				source: structuredClone(source.source),
				layerEdits,
			}),
		).not.toBe(key);
		original.release?.();
		edited.release?.();
		duplicate.release?.();
	} finally {
		client.dispose();
		await Promise.resolve();
		fixture.restore();
	}
});

test("authored layer IDs cannot terminate the trusted adapter script", () => {
	const script = hyperframesLayerEditsScript([
		{
			key: "dom/1/0",
			elementId: "</script><script>alert(1)</script>",
			opacity: 0,
		},
	]);
	expect(script).not.toContain("</script>");
	expect(script).toContain("\\u003c/script>");
});
