"use client";

import { useMemo } from "react";
import { useElementPlayhead } from "@/components/editor/panels/properties/hooks/use-element-playhead";
import { AnimatedGraphicParamField } from "@/graphics/components/graphic-tab";
import {
	graphicsRegistry,
	registerDefaultGraphics,
	resolveGraphicElementParamsAtTime,
} from "@/graphics";
import type { ParamDefinition, ParamValues } from "@/params";
import type { GraphicElement } from "@/timeline";
import type { MediaTime } from "@/wasm";
import {
	getAllUiElementAnimationOptions,
	getUiElementAnimationGroup,
	getUiElementAnimationOptions,
	type UiElementAnimationGroup,
	type UiElementAnimationOption,
} from "@/ui-elements/animation-options";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";

registerDefaultGraphics();

const TEXT_MOTION_PARAM_KEYS = [
	"textDirection",
	"textRevealMode",
	"textTransitionIn",
] as const;
const BUILT_IN_MOTION_PARAM_KEYS = [
	"animationIn",
	"animationInEnd",
	"animationOut",
	"animationOutStart",
	"eventAt",
	"animationStrength",
] as const;
const NEO_HUD_INTENSITY_TEMPLATES = new Set([
	"battery-drain",
	"hud-radar-sweep",
	"hud-target-lock",
	"hud-signal-scanner",
	"hud-data-core",
	"hud-alert-beacon",
	"hud-direction-shift",
	"wasted-overlay",
	"direction-cross-arrows",
]);
const SCREEN_MODE_TEMPLATES = new Set(["wasted-overlay"]);
const NO_TEXT_TEMPLATES = new Set(["direction-cross-arrows"]);

export function UiElementPropertiesTab({
	element,
	trackId,
}: {
	element: GraphicElement;
	trackId: string;
}) {
	const definition = graphicsRegistry.get(element.definitionId);
	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});
	const { renderElement } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});

	const liveElement = renderElement as GraphicElement;
	const resolvedParams = resolveGraphicElementParamsAtTime({
		element: liveElement,
		localTime,
	});
	const paramsByKey = useMemo(
		() => new Map(definition.params.map((param) => [param.key, param])),
		[definition.params],
	);
	const template = String(resolvedParams.template ?? "neon-button");
	const group = getUiElementAnimationGroup({ template });
	const contentParamKeys = getContentParamKeys({ template, group });
	const styleParamKeys = getStyleParamKeys({ template, group });
	const fontParamKeys = getFontParamKeys({ template, group });
	const listLayoutParamKeys = getListLayoutParamKeys({ group });
	const listControlParamKeys = getListControlParamKeys({ group });

	return (
		<div className="flex flex-col">
			<ParamSection
				title="Content"
				sectionKey={`${element.id}:ui-content`}
				keys={contentParamKeys}
				paramsByKey={paramsByKey}
				trackId={trackId}
				element={liveElement}
				localTime={localTime}
				isPlayheadWithinElementRange={isPlayheadWithinElementRange}
				resolvedParams={resolvedParams}
			/>
			<ParamSection
				title="Style"
				sectionKey={`${element.id}:ui-style`}
				keys={styleParamKeys}
				paramsByKey={paramsByKey}
				trackId={trackId}
				element={liveElement}
				localTime={localTime}
				isPlayheadWithinElementRange={isPlayheadWithinElementRange}
				resolvedParams={resolvedParams}
			/>
			<ParamSection
				title="List Layout"
				sectionKey={`${element.id}:ui-list-layout`}
				keys={listLayoutParamKeys}
				paramsByKey={paramsByKey}
				trackId={trackId}
				element={liveElement}
				localTime={localTime}
				isPlayheadWithinElementRange={isPlayheadWithinElementRange}
				resolvedParams={resolvedParams}
			/>
			<ParamSection
				title="Fonts"
				sectionKey={`${element.id}:ui-fonts`}
				keys={fontParamKeys}
				paramsByKey={paramsByKey}
				trackId={trackId}
				element={liveElement}
				localTime={localTime}
				isPlayheadWithinElementRange={isPlayheadWithinElementRange}
				resolvedParams={resolvedParams}
			/>
			<ParamSection
				title="Text Animation"
				sectionKey={`${element.id}:ui-text-motion`}
				keys={TEXT_MOTION_PARAM_KEYS}
				paramsByKey={paramsByKey}
				trackId={trackId}
				element={liveElement}
				localTime={localTime}
				isPlayheadWithinElementRange={isPlayheadWithinElementRange}
				resolvedParams={resolvedParams}
			/>
			<ParamSection
				title="List Timing"
				sectionKey={`${element.id}:ui-list-timing`}
				keys={listControlParamKeys}
				paramsByKey={paramsByKey}
				trackId={trackId}
				element={liveElement}
				localTime={localTime}
				isPlayheadWithinElementRange={isPlayheadWithinElementRange}
				resolvedParams={resolvedParams}
			/>
			<ParamSection
				title={`${formatGroupLabel(group)} Motion`}
				sectionKey={`${element.id}:ui-built-in-motion`}
				keys={BUILT_IN_MOTION_PARAM_KEYS}
				paramsByKey={paramsByKey}
				trackId={trackId}
				element={liveElement}
				localTime={localTime}
				isPlayheadWithinElementRange={isPlayheadWithinElementRange}
				resolvedParams={resolvedParams}
				template={template}
			/>
		</div>
	);
}

function ParamSection({
	title,
	sectionKey,
	keys,
	paramsByKey,
	trackId,
	element,
	localTime,
	isPlayheadWithinElementRange,
	resolvedParams,
	template,
}: {
	title: string;
	sectionKey: string;
	keys: readonly string[];
	paramsByKey: Map<string, ParamDefinition>;
	trackId: string;
	element: GraphicElement;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
	resolvedParams: ParamValues;
	template?: string;
}) {
	const availableKeys = keys.filter((key) => paramsByKey.has(key));
	if (availableKeys.length === 0) {
		return null;
	}

	return (
		<Section collapsible sectionKey={sectionKey}>
			<SectionHeader>
				<SectionTitle>{title}</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					{availableKeys.flatMap((key) => {
						const param = paramsByKey.get(key);
						if (!param) return [];
						const value = resolvedParams[param.key] ?? param.default;
						const fieldParam = getUiElementFieldParam({
							param,
							value,
							template,
						});
						return [
							<AnimatedGraphicParamField
								key={param.key}
								param={fieldParam}
								trackId={trackId}
								element={element}
								localTime={localTime}
								isPlayheadWithinElementRange={isPlayheadWithinElementRange}
								resolvedParams={resolvedParams}
								buildBaseUpdates={
									param.key === "template"
										? ({ value: nextTemplate }) => ({
												params: {
													...element.params,
													template: nextTemplate,
													animationIn: "auto",
													animationOut: "auto",
													itemStartPoints: "",
													itemEndPoints: "",
												},
											})
										: undefined
								}
							/>,
						];
					})}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}

function getContentParamKeys({
	template,
	group,
}: {
	template: string;
	group: UiElementAnimationGroup;
}): string[] {
	if (NO_TEXT_TEMPLATES.has(template)) {
		return ["template"];
	}
	if (group === "list") {
		return ["template", "items", "itemCount"];
	}
	if (
		group === "button" ||
		group === "loader" ||
		template === "hud-countdown"
	) {
		return ["template", "label"];
	}
	return ["template", "label", "secondary"];
}

function getStyleParamKeys({
	template,
	group,
}: {
	template: string;
	group: UiElementAnimationGroup;
}): string[] {
	const keys = ["accent", "background", "foreground"];
	if (group === "progress" || group === "direction") {
		keys.push("progress");
	}
	if (template === "battery-drain") {
		keys.push("batteryMode");
	}
	if (NEO_HUD_INTENSITY_TEMPLATES.has(template)) {
		keys.push("intensity");
	}
	if (SCREEN_MODE_TEMPLATES.has(template)) {
		keys.push("screenMode");
	}
	if (template === "checkbox-list") {
		keys.push("checked");
	}
	if (
		group === "counter" ||
		template === "rating-stars" ||
		template === "timeline-stepper"
	) {
		keys.push("count");
	}
	if (group === "loader") {
		keys.push("intensity");
	}
	return keys;
}

function getFontParamKeys({
	template,
	group,
}: {
	template: string;
	group: UiElementAnimationGroup;
}): string[] {
	if (NO_TEXT_TEMPLATES.has(template)) {
		return [];
	}
	if (group === "list") {
		return ["itemsFontFamily"];
	}
	if (group === "button" || group === "loader") {
		return ["labelFontFamily"];
	}
	return ["labelFontFamily", "secondaryFontFamily"];
}

function getListControlParamKeys({
	group,
}: {
	group: UiElementAnimationGroup;
}): string[] {
	if (group !== "list") {
		return [];
	}
	return [
		"listRevealMode",
		"listBaseOpacity",
		"listRiseDistance",
		"listItemInDuration",
		"listItemOutDuration",
		"itemStartPoints",
		"itemEndPoints",
	];
}

function getListLayoutParamKeys({
	group,
}: {
	group: UiElementAnimationGroup;
}): string[] {
	if (group !== "list") {
		return [];
	}
	return [
		"listBarFitToText",
		"listBarWidth",
		"listBarHeight",
		"listBarGap",
		"listBarRadius",
		"listBackgroundBlur",
		"listTextAlign",
		"listTextSize",
	];
}

function getUiElementFieldParam({
	param,
	value,
	template,
}: {
	param: ParamDefinition;
	value: ParamValues[string];
	template?: string;
}): ParamDefinition {
	if (param.type !== "select" || !template) {
		return param;
	}

	if (param.key === "animationIn") {
		return {
			...param,
			options: includeCurrentOption({
				options: getUiElementAnimationOptions({ template, side: "in" }),
				allOptions: getAllUiElementAnimationOptions({ side: "in" }),
				value,
			}),
		};
	}
	if (param.key === "animationOut") {
		return {
			...param,
			options: includeCurrentOption({
				options: getUiElementAnimationOptions({ template, side: "out" }),
				allOptions: getAllUiElementAnimationOptions({ side: "out" }),
				value,
			}),
		};
	}
	return param;
}

function includeCurrentOption({
	options,
	allOptions,
	value,
}: {
	options: UiElementAnimationOption[];
	allOptions: UiElementAnimationOption[];
	value: ParamValues[string];
}): UiElementAnimationOption[] {
	const currentValue = String(value);
	if (options.some((option) => option.value === currentValue)) {
		return options;
	}
	const currentOption =
		allOptions.find((option) => option.value === currentValue) ??
		({
			value: currentValue,
			label: `Current: ${currentValue}`,
		} satisfies UiElementAnimationOption);
	return [...options, currentOption];
}

function formatGroupLabel(group: string): string {
	return group
		.split("-")
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}
