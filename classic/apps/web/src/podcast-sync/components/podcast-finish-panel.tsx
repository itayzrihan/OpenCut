"use client";
import { useState } from "react";
import { CanonicalButton } from "@/components/editor/canonical-button";
import { useEditorTimelineScenes } from "@/editor/use-editor";

/** Explicit track choices keep intro music and unrelated footage out of the preset. */
export function PodcastFinishPanel() {
	const scene = useEditorTimelineScenes((e) => e.scenes.getActiveSceneOrNull());
	const [selected, setSelected] = useState<string[]>([]);
	if (!scene) return null;
	const tracks = [
		...scene.tracks.overlay,
		scene.tracks.main,
		...scene.tracks.audio,
	].filter(
		(t) => (t.type === "audio" || t.type === "video") && t.elements.length > 0,
	);
	if (!tracks.length) return null;
	const microphones = tracks
		.filter((t) => t.type === "audio" && selected.includes(t.id))
		.map((t) => t.id);
	const cameras = tracks
		.filter((t) => t.type === "video" && selected.includes(t.id))
		.map((t) => t.id);
	return (
		<details className="mb-4 rounded-lg border p-3">
			<summary className="cursor-pointer font-medium">
				Finish current timeline
			</summary>
			<p className="text-muted-foreground my-2 text-sm">
				Choose microphone and camera tracks from this edit. Applies Volume +15
				dB, Gain −1 dB, Hard Limiter −1 dB, Noise Reduction 25% and full-length
				Sharpen 15%. Existing cuts and sync stay in place. Leave intro music
				unchecked. Reapplying skips clips already finished.
			</p>
			<div className="grid gap-2 sm:grid-cols-2">
				{tracks.map((t) => (
					<label key={t.id} className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={selected.includes(t.id)}
							disabled={"locked" in t && t.locked === true}
							onChange={(event) =>
								setSelected((ids) =>
									event.target.checked
										? [...ids, t.id]
										: ids.filter((id) => id !== t.id),
								)
							}
						/>
						{t.type === "audio" ? "Microphone" : "Camera"}: {t.name}
					</label>
				))}
			</div>
			<CanonicalButton
				className="mt-3"
				variant="outline"
				disabled={!microphones.length || !cameras.length}
				action={{
					capabilityId: "timeline.classic.podcast.finish",
					input: {
						sceneId: scene.id,
						microphoneTrackIds: microphones,
						cameraTrackIds: cameras,
					},
				}}
			>
				Apply podcast finishing
			</CanonicalButton>
		</details>
	);
}
