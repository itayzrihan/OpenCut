import { buildScene } from "@/services/renderer/scene-builder";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import type { CanonicalClassicSnapshot } from "@/core/canonical-classic-session";

/** Actual production scene builder, WASM compositor, decoder and encoder. */
export async function exportReference(snapshot: CanonicalClassicSnapshot) {
	const media = await (await fetch("/clip.webm")).blob();
	const scene = snapshot.document.scenes[0];
	const url = URL.createObjectURL(media);
	try {
		const audioContext = new OfflineAudioContext(1, 96000, 48000);
		const decodedAudio = await audioContext.decodeAudioData(
			await (await fetch("/hyperframes-audio.m4a")).arrayBuffer(),
		);
		const audioBuffer = new AudioBuffer({
			numberOfChannels: decodedAudio.numberOfChannels,
			length: decodedAudio.sampleRate * 2,
			sampleRate: decodedAudio.sampleRate,
		});
		for (let channel = 0; channel < decodedAudio.numberOfChannels; channel++)
			audioBuffer.copyToChannel(
				decodedAudio.getChannelData(channel).subarray(0, audioBuffer.length),
				channel,
			);
		const rootNode = buildScene({
			tracks: scene.tracks,
			scenes: snapshot.document.scenes.map((scene) => ({ ...scene, createdAt: new Date(scene.createdAt), updatedAt: new Date(scene.updatedAt) })),
			activeSceneId: scene.id,
			mediaAssets: snapshot.mediaAssets.map((asset) => ({
				...asset,
				file: new File([media], "clip.webm", { type: "video/webm" }),
				url,
			})),
			duration: 2 * 120000,
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
			isPreview: false,
			hyperframes: {
				compositions: snapshot.document.hyperframesCompositions!,
				getResourceRevision: () => 0,
				renderTo: async ({ timeSeconds, target }) => {
					const response = await fetch(`/capture?time=${timeSeconds}`);
					if (!response.ok) throw new Error(await response.text());
					const bitmap = await createImageBitmap(await response.blob());
					try {
						const context = target.getContext("2d")!;
						context.clearRect(0, 0, target.width, target.height);
						context.drawImage(bitmap, 0, 0, target.width, target.height);
					} finally {
						bitmap.close();
					}
				},
			},
		});
		const exporter = new SceneExporter({
			width: 1920,
			height: 1080,
			fps: { numerator: 10, denominator: 1 },
			format: "webm",
			quality: "high",
			shouldIncludeAudio: true,
			audioBuffer,
		});
		const output = await exporter.export({ rootNode });
		if (!output) throw new Error("Export was cancelled");
		return Array.from(new Uint8Array(output));
	} finally {
		URL.revokeObjectURL(url);
	}
}
