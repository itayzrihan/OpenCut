"use client";

import { resolveAnimationPathValueAtTime } from "@/animation";
import { Section, SectionContent, SectionFields } from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import {
	getCachedFontAtlas,
	getGoogleFontVariants,
	loadFontAtlas,
	type GoogleFontVariant,
} from "@/fonts/google-fonts";
import {
	getCachedTypekitFonts,
	loadTypekitFonts,
	type TypekitFontVariant,
} from "@/fonts/typekit-fonts";
import { useElementPlayhead } from "@/components/editor/panels/properties/hooks/use-element-playhead";
import { useKeyframedParamProperty } from "@/components/editor/panels/properties/hooks/use-keyframed-param-property";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import type { ParamValue, ParamValues } from "@/params";
import {
	getElementParams,
	readElementParamValue,
	writeElementParamValue,
	type ElementParamDefinition,
} from "@/params/registry";
import type { TimelineElement } from "@/timeline";
import type { MediaTime } from "@/wasm";
import { useEffect, useMemo, useState } from "react";
import {
	buildScopedTextPatch,
	readScopedTextParamValue,
	textParamToScopedPatch,
	type TextOverrideScope,
} from "../text-scope";
import { shouldUseLiveElementParamPlayhead } from "../element-param-playhead";

type SelectOption = { value: string; label: string };

type FontVariant = {
	style: "normal" | "italic";
	weight: number;
};

const FALLBACK_FONT_WEIGHT_OPTIONS: SelectOption[] = [
	{ value: "normal", label: "Normal" },
	{ value: "bold", label: "Bold" },
];

const FALLBACK_FONT_STYLE_OPTIONS: SelectOption[] = [
	{ value: "normal", label: "Normal" },
	{ value: "italic", label: "Italic" },
];

const FONT_WEIGHT_LABELS = new Map<number, string>([
	[100, "100 Thin"],
	[200, "200 Extra Light"],
	[300, "300 Light"],
	[400, "400 Regular"],
	[500, "500 Medium"],
	[600, "600 Semi Bold"],
	[700, "700 Bold"],
	[800, "800 Extra Bold"],
	[900, "900 Black"],
]);

export type ElementWithTrackForParams = {
	track: { id: string };
	element: TimelineElement;
	textWordIds?: string[];
};

export function ElementParamsTab({
	element,
	trackId,
	elementsWithTracks,
	paramKeys,
	sectionKey,
	textScope,
}: {
	element: TimelineElement;
	trackId: string;
	elementsWithTracks?: ElementWithTrackForParams[];
	paramKeys?: readonly string[];
	sectionKey: string;
	textScope?: TextOverrideScope;
}) {
	const isScopedText =
		element.type === "text" &&
		textScope !== undefined &&
		textScope.type !== "layer";
	const params = getElementParams({ element })
		.filter((param) => !paramKeys || paramKeys.includes(param.key))
		.filter((param) =>
			isScopedText
				? textParamToScopedPatch({ key: param.key, value: param.default }) !==
					null
				: true,
		);
	const baseValues = buildValues({ element, params, textScope });
	const fontVariantOptions = useFontVariantOptions({
		fontFamily:
			typeof baseValues.fontFamily === "string"
				? baseValues.fontFamily
				: undefined,
		fontStyle:
			baseValues.fontStyle === "italic" || baseValues.fontStyle === "normal"
				? baseValues.fontStyle
				: "normal",
	});
	const bulkElements =
		elementsWithTracks && elementsWithTracks.length > 1
			? elementsWithTracks
			: null;
	const visibleParams = params.filter((param) =>
		isVisible({ param, values: baseValues }),
	);
	const shouldTrackPlayhead = shouldUseLiveElementParamPlayhead({
		params: visibleParams,
		isBulk: bulkElements !== null,
		isScopedText,
	});
	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
		enabled: shouldTrackPlayhead,
	});

	return (
		<Section sectionKey={`${element.id}:${sectionKey}`}>
			<SectionContent className="pt-4">
				<SectionFields>
					{visibleParams.map((param) => (
						<ElementParamField
							key={param.key}
							element={element}
							trackId={trackId}
							elementsWithTracks={bulkElements ?? undefined}
							param={withFontVariantOptions({
								param,
								fontVariantOptions,
							})}
							baseValue={baseValues[param.key] ?? param.default}
							isMixed={
								bulkElements
									? isMixedParamValue({
											elementsWithTracks: bulkElements,
											param,
										})
									: false
							}
							localTime={localTime}
							isPlayheadWithinElementRange={isPlayheadWithinElementRange}
							textScope={textScope}
						/>
					))}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}

function useFontVariantOptions({
	fontFamily,
	fontStyle,
}: {
	fontFamily?: string;
	fontStyle: "normal" | "italic";
}): {
	weightOptions: SelectOption[];
	styleOptions: SelectOption[];
} {
	const [atlas, setAtlas] = useState(() => getCachedFontAtlas());
	const [typekitFonts, setTypekitFonts] = useState(() =>
		getCachedTypekitFonts(),
	);

	useEffect(() => {
		if (!fontFamily) return;

		let isCancelled = false;
		Promise.all([loadFontAtlas(), loadTypekitFonts()]).then(
			([nextAtlas, nextTypekitFonts]) => {
				if (isCancelled) return;
				setAtlas(nextAtlas);
				setTypekitFonts(nextTypekitFonts);
			},
		);

		return () => {
			isCancelled = true;
		};
	}, [fontFamily]);

	return useMemo(() => {
		const variants = getFontVariantsForFamily({
			fontFamily,
			atlas,
			typekitFonts,
		});

		if (!variants || variants.length === 0) {
			return {
				weightOptions: FALLBACK_FONT_WEIGHT_OPTIONS,
				styleOptions: FALLBACK_FONT_STYLE_OPTIONS,
			};
		}

		const styleVariants = variants.filter(
			(variant) => variant.style === fontStyle,
		);
		const weightSource = styleVariants.length > 0 ? styleVariants : variants;

		return {
			weightOptions: buildWeightOptions({ variants: weightSource }),
			styleOptions: buildStyleOptions({ variants }),
		};
	}, [atlas, fontFamily, fontStyle, typekitFonts]);
}

function getFontVariantsForFamily({
	fontFamily,
	atlas,
	typekitFonts,
}: {
	fontFamily?: string;
	atlas: ReturnType<typeof getCachedFontAtlas>;
	typekitFonts: ReturnType<typeof getCachedTypekitFonts>;
}): FontVariant[] | null {
	if (!fontFamily) return null;

	const typekitFont = typekitFonts?.find((font) => font.family === fontFamily);
	if (typekitFont) {
		return typekitFont.variants.flatMap(toFontVariant);
	}

	const googleVariants = getGoogleFontVariants({ family: fontFamily, atlas });
	return googleVariants.length > 0
		? googleVariants.flatMap(toFontVariant)
		: null;
}

function toFontVariant(
	variant: GoogleFontVariant | TypekitFontVariant,
): FontVariant[] {
	if (variant.style !== "normal" && variant.style !== "italic") return [];
	return [{ style: variant.style, weight: variant.weight }];
}

function buildWeightOptions({
	variants,
}: {
	variants: FontVariant[];
}): SelectOption[] {
	const weights = [...new Set(variants.map((variant) => variant.weight))].sort(
		(left, right) => left - right,
	);

	return weights.map((weight) => ({
		value: String(weight),
		label: FONT_WEIGHT_LABELS.get(weight) ?? String(weight),
	}));
}

function buildStyleOptions({
	variants,
}: {
	variants: FontVariant[];
}): SelectOption[] {
	const styles = new Set(variants.map((variant) => variant.style));
	return FALLBACK_FONT_STYLE_OPTIONS.filter((option) =>
		styles.has(option.value as "normal" | "italic"),
	);
}

function withFontVariantOptions({
	param,
	fontVariantOptions,
}: {
	param: ElementParamDefinition;
	fontVariantOptions: {
		weightOptions: SelectOption[];
		styleOptions: SelectOption[];
	};
}): ElementParamDefinition {
	if (param.type !== "select") return param;
	if (param.key === "fontWeight") {
		return { ...param, options: fontVariantOptions.weightOptions };
	}
	if (param.key === "fontStyle") {
		return { ...param, options: fontVariantOptions.styleOptions };
	}
	return param;
}

function ElementParamField({
	element,
	trackId,
	elementsWithTracks,
	param,
	baseValue,
	isMixed,
	localTime,
	isPlayheadWithinElementRange,
	textScope,
}: {
	element: TimelineElement;
	trackId: string;
	elementsWithTracks?: ElementWithTrackForParams[];
	param: ElementParamDefinition;
	baseValue: ParamValue;
	isMixed: boolean;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
	textScope?: TextOverrideScope;
}) {
	const isScopedText =
		element.type === "text" &&
		textScope !== undefined &&
		textScope.type !== "layer" &&
		param.key !== "blendMode";
	const editor = useEditor();
	const isBulk = !!elementsWithTracks?.length;
	const keyframesEnabled =
		!isBulk && !isScopedText && param.keyframable !== false;
	const resolvedValue = isScopedText
		? readScopedTextParamValue({
				element,
				scope: textScope,
				key: param.key,
				fallbackValue: baseValue,
			})
		: resolveAnimationPathValueAtTime({
				animations: element.animations,
				propertyPath: param.key,
				localTime,
				fallbackValue: baseValue,
			});
	const animatedParam = useKeyframedParamProperty({
		param,
		trackId,
		elementId: element.id,
		animations: element.animations,
		propertyPath: param.key,
		localTime,
		isPlayheadWithinElementRange,
		resolvedValue,
		buildBaseUpdates: ({ value }) =>
			writeElementParamValue({ element, param, value }),
		enabled: keyframesEnabled,
	});

	const onPreview = (value: ParamValue) => {
		if (isScopedText) {
			const scopedPatch = textParamToScopedPatch({ key: param.key, value });
			if (!scopedPatch) return;
			const targetEntries = elementsWithTracks ?? [
				{ track: { id: trackId }, element },
			];

			editor.timeline.previewElements({
				updates: targetEntries.flatMap((entry) => {
					if (entry.element.type !== "text") return [];
					const entryScope = resolveTextScopeForEntry({
						textScope,
						entry,
					});
					if (!entryScope) return [];
					return [
						{
							trackId: entry.track.id,
							elementId: entry.element.id,
							updates: buildScopedTextPatch({
								element: entry.element,
								scope: entryScope,
								patch: scopedPatch,
							}),
						},
					];
				}),
			});
			return;
		}

		if (!elementsWithTracks) {
			animatedParam.onPreview(value);
			return;
		}

		editor.timeline.previewElements({
			updates: elementsWithTracks.map((entry) => ({
				trackId: entry.track.id,
				elementId: entry.element.id,
				updates: writeElementParamValue({
					element: entry.element,
					param,
					value,
				}),
			})),
		});
	};

	const onCommit = () => editor.timeline.commitPreview();

	return (
		<PropertyParamField
			param={param}
			value={resolvedValue}
			isMixed={isMixed}
			onPreview={onPreview}
			onCommit={isBulk || isScopedText ? onCommit : animatedParam.onCommit}
			keyframe={
				!keyframesEnabled
					? undefined
					: {
							isActive: animatedParam.isKeyframedAtTime,
							isDisabled: !isPlayheadWithinElementRange,
							onToggle: animatedParam.toggleKeyframe,
						}
			}
		/>
	);
}

function resolveTextScopeForEntry({
	textScope,
	entry,
}: {
	textScope: TextOverrideScope;
	entry: ElementWithTrackForParams;
}): TextOverrideScope | null {
	if (textScope.type !== "words") {
		return textScope;
	}

	const wordIds = entry.textWordIds ?? textScope.wordIds;
	return wordIds.length > 0 ? { type: "words", wordIds } : null;
}

function buildValues({
	element,
	params,
	textScope,
}: {
	element: TimelineElement;
	params: readonly ElementParamDefinition[];
	textScope?: TextOverrideScope;
}): ParamValues {
	const values: ParamValues = {};
	for (const param of params) {
		const value = readElementParamValue({ element, param });
		if (value !== null) {
			values[param.key] =
				element.type === "text" && textScope && textScope.type !== "layer"
					? readScopedTextParamValue({
							element,
							scope: textScope,
							key: param.key,
							fallbackValue: value,
						})
					: value;
		}
	}
	return values;
}

function isMixedParamValue({
	elementsWithTracks,
	param,
}: {
	elementsWithTracks: ElementWithTrackForParams[];
	param: ElementParamDefinition;
}) {
	const first = readElementParamValue({
		element: elementsWithTracks[0].element,
		param,
	});
	return elementsWithTracks.some(
		(entry) =>
			readElementParamValue({ element: entry.element, param }) !== first,
	);
}

function isVisible({
	param,
	values,
}: {
	param: ElementParamDefinition;
	values: ParamValues;
}): boolean {
	return (param.dependencies ?? []).every((dependency) =>
		areParamValuesEqual({
			left: values[dependency.param],
			right: dependency.equals,
		}),
	);
}

function areParamValuesEqual({
	left,
	right,
}: {
	left: ParamValue | undefined;
	right: ParamValue;
}): boolean {
	return left === right;
}
