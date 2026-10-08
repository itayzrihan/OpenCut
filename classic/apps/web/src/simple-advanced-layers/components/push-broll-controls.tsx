"use client";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import { toast } from "sonner";
import type { EffectElement } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";

export function PushBrollCards() {
	const editor = useEditor();
	return (
		<>
			{(["top", "bottom"] as const).map((edge) => (
				<Button
					key={edge}
					variant="outline"
					className="h-auto flex-col gap-2 p-3"
					onClick={() => {
						try {
							editor.command.createPushBroll({
								edge,
								startTime: editor.playback.getCurrentTime(),
								duration: 5 * TICKS_PER_SECOND,
							});
							toast.success(
								"B-roll scene created. Select the layer to edit its content.",
							);
						} catch (error) {
							toast.error(
								error instanceof Error ? error.message : "Could not add B-roll",
							);
						}
					}}
				>
					<div className="relative h-28 w-16 overflow-hidden rounded bg-slate-700">
						<div
							className={`absolute inset-x-0 h-[40%] bg-indigo-400 ${edge === "top" ? "top-0" : "bottom-0"}`}
						/>
						<div
							className={`absolute inset-x-2 h-8 rounded bg-slate-400 ${edge === "top" ? "bottom-2" : "top-2"}`}
						/>
					</div>
					<span>B-roll from {edge}</span>
				</Button>
			))}
		</>
	);
}

export function PushBrollProperties({
	element,
	trackId,
}: {
	element: EffectElement;
	trackId: string;
}) {
	const editor = useEditor();
	const update = (params: Record<string, string | number>) =>
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: { params: { ...element.params, ...params } },
				},
			],
		});
	return (
		<div className="space-y-4 p-3">
			<p>
				The main video moves as this scene slides in. Content is centered and
				cropped to the band; dialogue continues.
			</p>
			<label className="block">
				Edge
				<select
					className="ml-2 bg-background"
					value={String(element.params.edge)}
					onChange={(e) => update({ edge: e.target.value })}
				>
					<option value="top">Top</option>
					<option value="bottom">Bottom</option>
				</select>
			</label>
			<label className="block">
				Screen area (%)
				<input
					className="ml-2 w-20 bg-background"
					type="number"
					min={1}
					max={90}
					value={Number(element.params.screenPercent)}
					onChange={(e) => {
						const n = e.target.valueAsNumber;
						if (Number.isFinite(n) && n >= 1 && n <= 90)
							update({ screenPercent: n });
					}}
				/>
			</label>
			<label className="block">
				Entry / exit (seconds)
				<input
					className="ml-2 w-20 bg-background"
					type="number"
					min={0}
					max={10}
					step={0.1}
					value={Number(element.params.transitionSeconds)}
					onChange={(e) => {
						const n = e.target.valueAsNumber;
						if (Number.isFinite(n) && n >= 0 && n <= 10)
							update({ transitionSeconds: n });
					}}
				/>
			</label>
			<Button
				onClick={() => {
					editor.scenes
						.switchToScene({ sceneId: String(element.params.brollSceneId) })
						.catch((e: Error) => toast.error(e.message));
				}}
			>
				Edit B-roll scene
			</Button>
			<p className="text-xs text-muted-foreground">
				Add video, backgrounds, HyperFrames, text or captions. Use the Scenes
				list to return to the main scene. An empty scene leaves the main video
				in place.
			</p>
		</div>
	);
}
