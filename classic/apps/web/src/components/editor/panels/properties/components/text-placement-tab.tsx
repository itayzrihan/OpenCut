"use client";

import { useMemo, useState } from "react";
import { Section, SectionContent, SectionField } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import { getCaptionPlacementGrid } from "@/subtitles/caption-layout";
import {
	removeTextLineArrangementPreset,
	saveTextLineArrangementPreset,
	useTextLineArrangementPresets,
	type TextLineArrangementPreset,
} from "@/text/line-arrangement-presets";
import {
	getTextMeasurementContext,
	measureTextElement,
} from "@/text/measure-element";
import type { MeasuredWordGlyph } from "@/text/primitives";
import type { TextElement } from "@/timeline";
import { buildTransformFromParams, type Transform } from "@/rendering";
import type { ElementWithTrackForParams } from "./element-params-tab";
import {
	buildScopedTextPatch,
	getScopedSettings,
	getWordRuns,
	type TextOverrideScope,
} from "../text-scope";

type Point = { x: number; y: number };

interface ScopedPlacement {
	center: Point;
	localCenter: Point;
	scope: TextOverrideScope;
	transform: Transform;
}

interface PlacementTarget {
	trackId: string;
	element: TextElement;
	placement: ScopedPlacement;
}

export function TextPlacementTab({
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
	const presets = useTextLineArrangementPresets();
	const [presetName, setPresetName] = useState("");
	const [selectedPresetId, setSelectedPresetId] = useState("");
	const canvasSize = useEditorProject(
		(e) => e.project.getActive().settings.canvasSize,
	);
	const isBulk = (elementsWithTracks?.length ?? 0) > 1;
	const scope = textScope ?? { type: "layer" as const };
	const grid = getCaptionPlacementGrid({ canvasSize });
	const isBulkScopedPlacement = isBulk && scope.type !== "layer";
	const placementTargets = isBulkScopedPlacement
		? []
		: buildPlacementTargets({
				element,
				trackId,
				elementsWithTracks,
				scope: isBulk ? ({ type: "layer" } as const) : scope,
				canvasSize,
			});
	const placement = placementTargets[0]?.placement ?? null;
	const hasMixedPlacement =
		placementTargets.length > 1 &&
		placementTargets.some(
			(target) =>
				!arePointsEqual({
					left: target.placement.center,
					right: placementTargets[0].placement.center,
				}),
		);
	const selectedCell = placement && !hasMixedPlacement
		? getNearestGridCell({ center: placement.center, canvasSize, grid })
		: null;
	const lineArrangement = useMemo(
		() =>
			isBulk
				? null
				: getLineArrangement({
						element,
						canvasSize,
					}),
		[element, canvasSize, isBulk],
	);
	const canUseLineArrangement = (lineArrangement?.lines.length ?? 0) > 1;

	const applyCenter = (targetCenter: Point) => {
		if (placementTargets.length === 0) return;
		editor.timeline.updateElements({
			updates: placementTargets.map((target) => ({
				trackId: target.trackId,
				elementId: target.element.id,
				patch: buildPlacementPatch({
					element: target.element,
					placement: target.placement,
					targetCenter,
				}),
			})),
		});
	};

	const applyAxis = ({ axis, value }: { axis: "x" | "y"; value: string }) => {
		if (placementTargets.length === 0) return;
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) return;
		editor.timeline.updateElements({
			updates: placementTargets.map((target) => ({
				trackId: target.trackId,
				elementId: target.element.id,
				patch: buildPlacementPatch({
					element: target.element,
					placement: target.placement,
					targetCenter: {
						x: axis === "x" ? parsed : target.placement.center.x,
						y: axis === "y" ? parsed : target.placement.center.y,
					},
				}),
			})),
		});
	};
	const applyLineAxis = ({
		lineIndex,
		linePositionIndex,
		axis,
		value,
	}: {
		lineIndex: number;
		linePositionIndex: number;
		axis: "x" | "y";
		value: string;
	}) => {
		if (!lineArrangement) return;
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) return;
		const currentLine = lineArrangement.lines[linePositionIndex];
		if (!currentLine) return;
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: buildLinePositionPatch({
						element,
						lineIndex,
						currentLine,
						targetLine: {
							x: axis === "x" ? parsed : currentLine.x,
							y: axis === "y" ? parsed : currentLine.y,
						},
					}),
				},
			],
		});
	};
	const saveArrangement = () => {
		if (!canUseLineArrangement || !presetName.trim()) return;
		saveTextLineArrangementPreset({
			name: presetName,
			lines: lineArrangement?.lines ?? [],
		});
		setPresetName("");
	};
	const applyPreset = (presetId: string) => {
		const preset = presets.find((candidate) => candidate.id === presetId);
		if (!preset || !canUseLineArrangement || !lineArrangement) return;
		setSelectedPresetId(presetId);
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: buildLineArrangementPatch({
						element,
						lineIndexes: lineArrangement.lineIndexes,
						currentLines: lineArrangement.lines,
						preset,
					}),
				},
			],
		});
	};

	if (isBulkScopedPlacement) {
		return (
			<Section sectionKey={`${element.id}:placement`}>
				<SectionContent className="pt-4">
					<p className="text-muted-foreground text-sm">
						Select one text layer to edit scoped placement.
					</p>
				</SectionContent>
			</Section>
		);
	}

	return (
		<Section sectionKey={`${element.id}:placement`}>
			<SectionContent className="pt-4">
				<div className="flex flex-col gap-3.5">
					{hasMixedPlacement && (
						<p className="border-caution/20 bg-caution/10 text-caution rounded-sm border px-2.5 py-2 text-xs">
							Mixed placement values. The next placement change applies to all
							selected text layers.
						</p>
					)}
					<SectionField label={`Grid position (${grid.columns}x${grid.rows})`}>
						<div
							className="grid gap-1"
							style={{
								gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
							}}
						>
							{Array.from({ length: grid.rows }).flatMap((_, rowIndex) =>
								Array.from({ length: grid.columns }).map((__, columnIndex) => {
									const isSelected =
										selectedCell?.columnIndex === columnIndex &&
										selectedCell?.rowIndex === rowIndex;
									return (
										<button
											key={`${columnIndex}:${rowIndex}`}
											type="button"
											aria-label={`Place ${scope.type} at column ${columnIndex + 1}, row ${rowIndex + 1}`}
											className={`border-border bg-input hover:bg-accent focus-visible:ring-ring flex h-7 items-center justify-center rounded-sm border outline-none focus-visible:ring-2 ${
												isSelected ? "border-primary bg-primary/15" : ""
											}`}
											onClick={() =>
												applyCenter(
													getGridCellCenter({
														columnIndex,
														rowIndex,
														grid,
														canvasSize,
													}),
												)
											}
										>
											<span
												className={`size-1.5 rounded-full ${
													isSelected ? "bg-primary" : "bg-muted-foreground/35"
												}`}
											/>
										</button>
									);
								}),
							)}
						</div>
					</SectionField>

					<SectionField label="Exact center X/Y">
						<div className="grid grid-cols-2 gap-2">
							<Input
								type="number"
								step={1}
								size="sm"
								value={
									placement && !hasMixedPlacement
										? formatPlacementValue(placement.center.x)
										: ""
								}
								placeholder={hasMixedPlacement ? "Mixed" : undefined}
								aria-label={`${scope.type} center X position`}
								onChange={(event) =>
									applyAxis({ axis: "x", value: event.target.value })
								}
							/>
							<Input
								type="number"
								step={1}
								size="sm"
								value={
									placement && !hasMixedPlacement
										? formatPlacementValue(placement.center.y)
										: ""
								}
								placeholder={hasMixedPlacement ? "Mixed" : undefined}
								aria-label={`${scope.type} center Y position`}
								onChange={(event) =>
									applyAxis({ axis: "y", value: event.target.value })
								}
							/>
						</div>
					</SectionField>
					{canUseLineArrangement && (
						<SectionField label="Line positions">
							<div className="flex flex-col gap-2">
								{lineArrangement?.lineIndexes.map((lineIndex, index) => {
									const line = lineArrangement.lines[index] ?? { x: 0, y: 0 };
									return (
										<div
											key={lineIndex}
											className="grid grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2"
										>
											<span className="text-muted-foreground text-xs">
												Line {index + 1}
											</span>
											<Input
												type="number"
												step={1}
												size="sm"
												value={formatPlacementValue(line.x)}
												aria-label={`Line ${index + 1} X position`}
												onChange={(event) =>
													applyLineAxis({
														lineIndex,
														linePositionIndex: index,
														axis: "x",
														value: event.target.value,
													})
												}
											/>
											<Input
												type="number"
												step={1}
												size="sm"
												value={formatPlacementValue(line.y)}
												aria-label={`Line ${index + 1} Y position`}
												onChange={(event) =>
													applyLineAxis({
														lineIndex,
														linePositionIndex: index,
														axis: "y",
														value: event.target.value,
													})
												}
											/>
										</div>
									);
								})}
							</div>
						</SectionField>
					)}
					{canUseLineArrangement && (
						<SectionField label="Line position presets">
							<div className="flex flex-col gap-2">
								<div className="flex gap-2">
									<Select
										value={selectedPresetId}
										onValueChange={applyPreset}
										disabled={presets.length === 0}
									>
										<SelectTrigger className="min-w-0 flex-1">
											<SelectValue placeholder="Apply preset" />
										</SelectTrigger>
										<SelectContent>
											{presets.map((preset) => (
												<SelectItem key={preset.id} value={preset.id}>
													{preset.lines.length} lines - {preset.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Button
										type="button"
										variant="secondary"
										size="sm"
										disabled={!selectedPresetId}
										onClick={() => {
											removeTextLineArrangementPreset({
												id: selectedPresetId,
											});
											setSelectedPresetId("");
										}}
									>
										Delete
									</Button>
								</div>
								<div className="flex gap-2">
									<Input
										size="sm"
										value={presetName}
										placeholder={`${lineArrangement?.lines.length ?? 0}-line preset name`}
										onChange={(event) => setPresetName(event.target.value)}
									/>
									<Button
										type="button"
										size="sm"
										disabled={!presetName.trim()}
										onClick={saveArrangement}
									>
										Save
									</Button>
								</div>
							</div>
						</SectionField>
					)}
				</div>
			</SectionContent>
		</Section>
	);
}

function buildPlacementTargets({
	element,
	trackId,
	elementsWithTracks,
	scope,
	canvasSize,
}: {
	element: TextElement;
	trackId: string;
	elementsWithTracks?: ElementWithTrackForParams[];
	scope: TextOverrideScope;
	canvasSize: { width: number; height: number };
}): PlacementTarget[] {
	const entries = elementsWithTracks?.length
		? elementsWithTracks
		: [{ track: { id: trackId }, element }];

	return entries.flatMap((entry): PlacementTarget[] => {
		if (entry.element.type !== "text") return [];
		return [
			{
				trackId: entry.track.id,
				element: entry.element,
				placement: resolveScopedPlacement({
					element: entry.element,
					scope,
					canvasSize,
				}),
			},
		];
	});
}

function resolveScopedPlacement({
	element,
	scope,
	canvasSize,
}: {
	element: TextElement;
	scope: TextOverrideScope;
	canvasSize: { width: number; height: number };
}): ScopedPlacement {
	const transform = buildTransformFromParams({ params: element.params });
	const measurementElement =
		(element.wordRuns?.length ?? 0) > 0
			? element
			: {
					...element,
					wordRuns: getWordRuns({ element }),
				};
	const measured = measureTextElement({
		element: measurementElement,
		canvasHeight: canvasSize.height,
		localTime: 0,
		ctx: getTextMeasurementContext(),
	});
	const localCenter =
		scope.type === "layer"
			? getRectCenter(measured.visualRect)
			: (getScopedWordsCenter({
					element: measurementElement,
					measured,
					scope,
				}) ?? getRectCenter(measured.visualRect));
	const projectedCenter = projectLocalPoint({ point: localCenter, transform });

	return {
		center: {
			x: transform.position.x + projectedCenter.x,
			y: transform.position.y + projectedCenter.y,
		},
		localCenter,
		scope,
		transform,
	};
}

function buildPlacementPatch({
	element,
	placement,
	targetCenter,
}: {
	element: TextElement;
	placement: ScopedPlacement;
	targetCenter: Point;
}): Partial<TextElement> {
	if (placement.scope.type === "layer") {
		const projectedLocalCenter = projectLocalPoint({
			point: placement.localCenter,
			transform: placement.transform,
		});
		return {
			params: {
				"transform.positionX": targetCenter.x - projectedLocalCenter.x,
				"transform.positionY": targetCenter.y - projectedLocalCenter.y,
			},
		};
	}

	const localTarget = unprojectCanvasPoint({
		point: targetCenter,
		transform: placement.transform,
	});
	const delta = {
		x: localTarget.x - placement.localCenter.x,
		y: localTarget.y - placement.localCenter.y,
	};
	const settings = getScopedSettings({ element, scope: placement.scope });
	const ownStyle = settings.style ?? {};

	return buildScopedTextPatch({
		element,
		scope: placement.scope,
		patch: {
			style: {
				offsetX: (ownStyle.offsetX ?? 0) + delta.x,
				offsetY: (ownStyle.offsetY ?? 0) + delta.y,
			},
		},
	});
}

function getLineArrangement({
	element,
	canvasSize,
}: {
	element: TextElement;
	canvasSize: { width: number; height: number };
}): { lineIndexes: number[]; lines: TextLineArrangementPreset["lines"] } {
	const measurementElement =
		(element.wordRuns?.length ?? 0) > 0
			? element
			: {
					...element,
					wordRuns: getWordRuns({ element }),
				};
	const measured = measureTextElement({
		element: measurementElement,
		canvasHeight: canvasSize.height,
		localTime: 0,
		ctx: getTextMeasurementContext(),
	});
	const lineIndexes = [
		...new Set(
			getWordRuns({ element: measurementElement }).map(
				(word) => word.lineIndex ?? 0,
			),
		),
	].sort((left, right) => left - right);

	return {
		lineIndexes,
		lines: lineIndexes.map((lineIndex) => {
			const center =
				getScopedWordsCenter({
					element: measurementElement,
					measured,
					scope: { type: "row", lineIndex },
				}) ?? { x: 0, y: 0 };
			return center;
		}),
	};
}

function buildLineArrangementPatch({
	element,
	lineIndexes,
	currentLines,
	preset,
}: {
	element: TextElement;
	lineIndexes: number[];
	currentLines: TextLineArrangementPreset["lines"];
	preset: TextLineArrangementPreset;
}): Partial<TextElement> {
	const spacing = getOverflowLineSpacing({
		preset,
		currentLines,
	});
	let patch: Partial<TextElement> = {};
	let draft = element;

	lineIndexes.forEach((lineIndex, index) => {
		const currentLine = currentLines[index] ?? { x: 0, y: 0 };
		const presetLine =
			preset.lines[index] ??
			getOverflowPresetLine({
				preset,
				index,
				spacing,
			});
		const settings = getScopedSettings({
			element: draft,
			scope: { type: "row", lineIndex },
		});
		const ownStyle = settings.style ?? {};
		patch = buildScopedTextPatch({
			element: draft,
			scope: { type: "row", lineIndex },
			patch: {
				style: {
					offsetX: (ownStyle.offsetX ?? 0) + presetLine.x - currentLine.x,
					offsetY: (ownStyle.offsetY ?? 0) + presetLine.y - currentLine.y,
				},
			},
		});
		draft = { ...draft, ...patch };
	});

	return {
		wordRuns: draft.wordRuns,
		textRowOverrides: draft.textRowOverrides,
	};
}

function buildLinePositionPatch({
	element,
	lineIndex,
	currentLine,
	targetLine,
}: {
	element: TextElement;
	lineIndex: number;
	currentLine: Point;
	targetLine: Point;
}): Partial<TextElement> {
	const settings = getScopedSettings({
		element,
		scope: { type: "row", lineIndex },
	});
	const ownStyle = settings.style ?? {};
	return buildScopedTextPatch({
		element,
		scope: { type: "row", lineIndex },
		patch: {
			style: {
				offsetX: (ownStyle.offsetX ?? 0) + targetLine.x - currentLine.x,
				offsetY: (ownStyle.offsetY ?? 0) + targetLine.y - currentLine.y,
			},
		},
	});
}

function getOverflowLineSpacing({
	preset,
	currentLines,
}: {
	preset: TextLineArrangementPreset;
	currentLines: TextLineArrangementPreset["lines"];
}) {
	if (preset.lines.length >= 2) {
		const last = preset.lines[preset.lines.length - 1];
		const previous = preset.lines[preset.lines.length - 2];
		const presetSpacing = Math.abs(last.y - previous.y);
		if (presetSpacing > 0) return presetSpacing;
	}
	if (currentLines.length >= 2) {
		const last = currentLines[currentLines.length - 1];
		const previous = currentLines[currentLines.length - 2];
		const currentSpacing = Math.abs(last.y - previous.y);
		if (currentSpacing > 0) return currentSpacing;
	}
	return 48;
}

function getOverflowPresetLine({
	preset,
	index,
	spacing,
}: {
	preset: TextLineArrangementPreset;
	index: number;
	spacing: number;
}) {
	const anchor = preset.lines[preset.lines.length - 1] ?? { x: 0, y: 0 };
	return {
		x: 0,
		y: anchor.y + spacing * (index - preset.lines.length + 1),
	};
}

function getScopedWordsCenter({
	element,
	measured,
	scope,
}: {
	element: TextElement;
	measured: ReturnType<typeof measureTextElement>;
	scope: Exclude<TextOverrideScope, { type: "layer" }>;
}): Point | null {
	const wordLineIndexes = new Map(
		getWordRuns({ element }).map((word) => [word.id, word.lineIndex ?? 0]),
	);
	const words = (measured.wordLines ?? [])
		.flatMap((line) => line.words)
		.filter((word) => {
			if (scope.type === "word") {
				return word.id === scope.wordId;
			}
			if (scope.type === "words") {
				return scope.wordIds.includes(word.id);
			}
			return wordLineIndexes.get(word.id) === scope.lineIndex;
		});

	if (words.length === 0) {
		return null;
	}

	return getWordsCenter({ words });
}

function getWordsCenter({ words }: { words: MeasuredWordGlyph[] }): Point {
	let left = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;

	for (const word of words) {
		const wordLeft = word.x + word.offsetX;
		const wordRight = wordLeft + word.layoutWidth;
		const wordTop = word.y + word.offsetY - word.scaledFontSize / 2;
		const wordBottom = word.y + word.offsetY + word.scaledFontSize / 2;
		left = Math.min(left, wordLeft);
		right = Math.max(right, wordRight);
		top = Math.min(top, wordTop);
		bottom = Math.max(bottom, wordBottom);
	}

	return {
		x: left + (right - left) / 2,
		y: top + (bottom - top) / 2,
	};
}

function arePointsEqual({
	left,
	right,
}: {
	left: Point;
	right: Point;
}): boolean {
	return (
		Math.abs(left.x - right.x) < 0.01 &&
		Math.abs(left.y - right.y) < 0.01
	);
}

function getGridCellCenter({
	columnIndex,
	rowIndex,
	grid,
	canvasSize,
}: {
	columnIndex: number;
	rowIndex: number;
	grid: { columns: number; rows: number };
	canvasSize: { width: number; height: number };
}): Point {
	return {
		x:
			((columnIndex + 0.5) / grid.columns) * canvasSize.width -
			canvasSize.width / 2,
		y:
			((rowIndex + 0.5) / grid.rows) * canvasSize.height -
			canvasSize.height / 2,
	};
}

function getNearestGridCell({
	center,
	canvasSize,
	grid,
}: {
	center: Point;
	canvasSize: { width: number; height: number };
	grid: { columns: number; rows: number };
}) {
	return {
		columnIndex: clampInteger({
			value: Math.round(
				((center.x + canvasSize.width / 2) / canvasSize.width) * grid.columns -
					0.5,
			),
			min: 0,
			max: grid.columns - 1,
		}),
		rowIndex: clampInteger({
			value: Math.round(
				((center.y + canvasSize.height / 2) / canvasSize.height) * grid.rows -
					0.5,
			),
			min: 0,
			max: grid.rows - 1,
		}),
	};
}

function getRectCenter(rect: {
	left: number;
	top: number;
	width: number;
	height: number;
}): Point {
	return {
		x: rect.left + rect.width / 2,
		y: rect.top + rect.height / 2,
	};
}

function projectLocalPoint({
	point,
	transform,
}: {
	point: Point;
	transform: Transform;
}): Point {
	const scaled = {
		x: point.x * transform.scaleX,
		y: point.y * transform.scaleY,
	};
	const radians = (transform.rotate * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);

	return {
		x: scaled.x * cos - scaled.y * sin,
		y: scaled.x * sin + scaled.y * cos,
	};
}

function unprojectCanvasPoint({
	point,
	transform,
}: {
	point: Point;
	transform: Transform;
}): Point {
	const translated = {
		x: point.x - transform.position.x,
		y: point.y - transform.position.y,
	};
	const radians = (-transform.rotate * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const unrotated = {
		x: translated.x * cos - translated.y * sin,
		y: translated.x * sin + translated.y * cos,
	};

	return {
		x: unrotated.x / (transform.scaleX || 1),
		y: unrotated.y / (transform.scaleY || 1),
	};
}

function clampInteger({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}) {
	return Math.min(max, Math.max(min, Math.round(value)));
}

function formatPlacementValue(value: number): string {
	if (!Number.isFinite(value)) return "0";
	return String(Math.round(value * 100) / 100);
}
