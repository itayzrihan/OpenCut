"use client";

import { Button } from "@/components/ui/button";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import {
	buildTextLayoutParamsFromElement,
	getTextMeasurementContext,
} from "@/text/measure-element";
import { buildAutoFitTextPatch } from "@/text/responsive-wrap";
import type { TextElement } from "@/timeline";
import { WandSparkles } from "lucide-react";
import type { TextOverrideScope } from "../text-scope";
import { TEXT_PARAM_KEYS } from "../text-param-keys";
import {
	ElementParamsTab,
	type ElementWithTrackForParams,
} from "./element-params-tab";

const DEFAULT_AUTO_FIT_WIDTH_RATIO = 0.8;

export function TextTab({
	element,
	trackId,
	elementsWithTracks,
	textScope,
}: {
	element: TextElement;
	trackId: string;
	elementsWithTracks?: ElementWithTrackForParams[];
	textScope?: TextOverrideScope;
}) {
	const editor = useEditor();
	const canvasSize = useEditorProject(
		(current) => current.project.getActive().settings.canvasSize,
	);
	const targets = (
		elementsWithTracks ?? [{ track: { id: trackId }, element }]
	).flatMap((entry) =>
		entry.element.type === "text"
			? [{ trackId: entry.track.id, element: entry.element }]
			: [],
	);

	const autoFitText = () => {
		const ctx = getTextMeasurementContext();
		editor.timeline.updateElements({
			updates: targets.map((target) => ({
				trackId: target.trackId,
				elementId: target.element.id,
				patch: buildAutoFitTextPatch({
					element: target.element,
					text: buildTextLayoutParamsFromElement({ element: target.element }),
					canvasHeight: canvasSize.height,
					maxWidth: getAutoFitMaxWidth({
						element: target.element,
						canvasSize,
					}),
					ctx,
				}),
			})),
		});
	};

	return (
		<>
			<div className="border-b p-3.5">
				<Button
					type="button"
					variant="outline"
					className="w-full"
					onClick={autoFitText}
					disabled={targets.length === 0}
				>
					<WandSparkles className="size-4" />
					Auto-fit text lines
				</Button>
				<p className="mt-2 text-xs leading-relaxed text-muted-foreground">
					Reflows the current text to the layer and video width. Future size
					changes stay responsive.
				</p>
			</div>
			<ElementParamsTab
				element={element}
				trackId={trackId}
				elementsWithTracks={elementsWithTracks}
				paramKeys={TEXT_PARAM_KEYS}
				sectionKey="text"
				textScope={textScope}
			/>
		</>
	);
}

function getAutoFitMaxWidth({
	element,
	canvasSize,
}: {
	element: TextElement;
	canvasSize: { width: number; height: number };
}) {
	const storedResponsiveWidth = element.responsiveText
		? element.responsiveText.maxWidth *
			(canvasSize.height / Math.max(1, element.responsiveText.canvasHeight))
		: null;
	return (
		storedResponsiveWidth ?? canvasSize.width * DEFAULT_AUTO_FIT_WIDTH_RATIO
	);
}
