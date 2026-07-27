import { describe, expect, test } from "bun:test";
import { mergeElementOverlay } from "@/timeline/element-overlay";
import type { TextElement } from "@/timeline/types";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function textElement(): TextElement {
	return {
		id: "title",
		type: "text",
		name: "Title",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 100 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			content: "Original",
			fontSize: 48,
			fontFamily: "Impact",
			color: "#ff00ff",
			textAlign: "center",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			letterSpacing: 2,
			lineHeight: 1.1,
			"background.enabled": true,
			"background.color": "#111111",
			"transform.positionX": 20,
			"transform.positionY": 40,
			"transform.scaleX": 1.2,
			"transform.scaleY": 1.2,
			"transform.rotate": 8,
			opacity: 0.75,
		},
	};
}

describe("mergeElementOverlay", () => {
	test("deep-merges params so text content previews keep existing styles", () => {
		const element = textElement();
		const previewElement = mergeElementOverlay({
			base: element,
			overlay: { params: { content: "Edited" } },
		});

		expect(previewElement.params.content).toBe("Edited");
		expect(previewElement.params.fontFamily).toBe("Impact");
		expect(previewElement.params.color).toBe("#ff00ff");
		expect(previewElement.params["background.enabled"]).toBe(true);
		expect(previewElement.params["transform.positionX"]).toBe(20);
		expect(previewElement.params.opacity).toBe(0.75);
	});
});
