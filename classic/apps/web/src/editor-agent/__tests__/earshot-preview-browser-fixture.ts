import type { EditorCore } from "@/core";
import { createEarshotSpec } from "@/earshot/catalog";
import { disposeEarshotRenderer } from "@/earshot/render";
import { performEarshotPreviewEffect } from "../earshot-preview-effect";

export async function previewCodeSound(custom: boolean) {
	window.__opencutAccountId = "earshot-mcp-fixture";
	const spec = {
		...createEarshotSpec("ui_pop/soft"),
		duration: 0.15,
		...(custom
			? {
					sourceCode:
						'def render(params, r):\n t = np.arange(round(params["duration"]*48000))/48000\n return np.sin(2*np.pi*440*t)*0.2',
					echo: { delay: 0.02, feedback: 0.2, mix: 0.1 },
				}
			: {}),
	};
	// IO fixture only: mutation/serialization is tested in the real registry.
	const editor = {
		project: {
			getActiveOrNull: () => ({ metadata: { id: "preview-fixture" } }),
		},
		command: { getCanonicalRevision: () => 7 },
	} as unknown as EditorCore;
	try {
		const result = await performEarshotPreviewEffect({
			editor,
			accountId: "earshot-mcp-fixture",
			signal: new AbortController().signal,
			effect: {
				id: 1,
				projectId: "preview-fixture",
				adapter: "earshotPreview",
				request: {
					projectId: "preview-fixture",
					expectedRevision: 7,
					procedural: spec,
					startFrame: 960,
					frames: 4800,
				},
			},
		});
		if (result.type !== "success") throw new Error(result.message);
		const data = result.data as { channels: number; pcm16Base64: string };
		const bytes = Uint8Array.from(atob(data.pcm16Base64), (c) =>
			c.charCodeAt(0),
		);
		const view = new DataView(bytes.buffer);
		let energy = 0,
			peak = 0;
		for (let i = 0; i < bytes.length; i += 2) {
			const sample = view.getInt16(i, true) / 32768;
			energy += sample * sample;
			peak = Math.max(peak, Math.abs(sample));
		}
		return {
			bytes: bytes.length,
			channels: data.channels,
			peak,
			rms: Math.sqrt(energy / (bytes.length / 2)),
		};
	} finally {
		disposeEarshotRenderer();
	}
}
