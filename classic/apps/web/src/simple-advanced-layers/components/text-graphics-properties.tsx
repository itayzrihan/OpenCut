"use client";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import type { TextElement } from "@/timeline";
import { toast } from "sonner";
export function TextGraphicsProperties({
	element,
	trackId,
}: {
	element: TextElement;
	trackId: string;
}) {
	const editor = useEditor();
	const sceneId = element.params.textGraphicsSceneId;
	const attempt = (action: () => void) => {
		try {
			action();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Could not update graphics");
		}
	};
	const update = (params: Record<string, string | number>) =>
		attempt(() =>
			editor.timeline.updateElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						patch: { params: { ...element.params, ...params } },
					},
				],
			}),
		);
	return (
		<div className="space-y-4 p-3">
			<p>
				Add icons, graphics, UI Elements or animations above or below this text.
				The text moves in the opposite direction as the content enters.
			</p>
			{!sceneId ? (
				<div className="flex gap-2">
					{(["top", "bottom"] as const).map((edge) => (
						<Button
							key={edge}
							variant="outline"
							onClick={() =>
								attempt(() =>
									editor.command.createTextGraphics({
										trackId,
										elementId: element.id,
										edge,
									}),
								)
							}
						>
							Add {edge === "top" ? "above" : "below"} text
						</Button>
					))}
				</div>
			) : (
				<>
					<label className="block">
						Placement{" "}
						<select
							className="bg-background"
							value={String(element.params.textGraphicsEdge)}
							onChange={(e) => update({ textGraphicsEdge: e.target.value })}
						>
							<option value="top">Above text</option>
							<option value="bottom">Below text</option>
						</select>
					</label>
					<label className="block">
						Content size (%){" "}
						<input
							className="w-20 bg-background"
							type="number"
							min={1}
							max={60}
							value={Number(element.params.textGraphicsSizePercent)}
							onChange={(e) => {
								const n = e.target.valueAsNumber;
								if (Number.isFinite(n) && n >= 1 && n <= 60)
									update({ textGraphicsSizePercent: n });
							}}
						/>
					</label>
					<label className="block">
						Entry / exit (seconds){" "}
						<input
							className="w-20 bg-background"
							type="number"
							min={0}
							max={10}
							step={0.1}
							value={Number(element.params.textGraphicsTransitionSeconds)}
							onChange={(e) => {
								const n = e.target.valueAsNumber;
								if (Number.isFinite(n) && n >= 0 && n <= 10)
									update({ textGraphicsTransitionSeconds: n });
							}}
						/>
					</label>
					<Button
						onClick={() => {
							editor.scenes
								.switchToScene({ sceneId: String(sceneId) })
								.catch((e: Error) => toast.error(e.message));
						}}
					>
						Edit graphics scene
					</Button>
					<Button
						variant="outline"
						onClick={() =>
							attempt(() => {
								const params = { ...element.params };
								for (const key of [
									"textGraphicsSceneId",
									"textGraphicsEdge",
									"textGraphicsSizePercent",
									"textGraphicsTransitionSeconds",
								])
									delete params[key];
								editor.timeline.updateElements({
									updates: [
										{ trackId, elementId: element.id, patch: { params } },
									],
								});
							})
						}
					>
						Detach graphics
					</Button>
					<p className="text-xs text-muted-foreground">
						Content follows this text’s timing. Edit its scene to arrange
						multiple graphics, then return through the Scenes list. Empty
						content leaves the text in place. Detaching keeps the content scene
						for reuse.
					</p>
				</>
			)}
		</div>
	);
}
