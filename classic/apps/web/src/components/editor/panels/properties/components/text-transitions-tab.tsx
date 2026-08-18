"use client";

import { useState } from "react";
import { VolumeHighIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import type { TextElement, TimelineElement } from "@/timeline";
import { getDisplayTracks } from "@/timeline";
import {
	DEFAULT_TRANSITION_PERCENT,
	TRANSITION_PRESETS,
	arrangeOverlappingTextTransitions,
	clampTransitionPercent,
	getOverlappingTextTransitionEntries,
	hasTextTransitionSfx,
} from "@/transitions";
import { mediaTimeToSeconds } from "@/wasm";
import type { ElementWithTrackForParams } from "./element-params-tab";
import {
	buildScopedTextPatch,
	getScopedSettings,
	type TextOverrideScope,
	type TextScopedSettings,
} from "../text-scope";
import {
	REVEAL_MODES,
	TRANSITION_IN_OPTIONS,
	WORD_DIRECTIONS,
	toRevealMode,
	toTransitionIn,
} from "../text-word-controls";

function durationToPercent({
	element,
	duration,
}: {
	element: TimelineElement;
	duration: TimelineElement["duration"];
}) {
	const elementSeconds = mediaTimeToSeconds({ time: element.duration });
	if (elementSeconds <= 0) return 0;
	return clampTransitionPercent(
		(mediaTimeToSeconds({ time: duration }) / elementSeconds) * 100,
	);
}

export function TextTransitionsTab({
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
	const scope = textScope ?? { type: "layer" as const };
	const isScopedWordTransition =
		scope.type !== "layer" &&
		((elementsWithTracks?.length ?? 0) <= 1 || scope.type === "words");
	const scopedSettings = getScopedSettings({ element, scope });
	const glowerEnabled = scopedSettings.glowerEnabled ?? false;
	const updateGlower = (patch: TextScopedSettings) => {
		editor.timeline.updateElements({
			updates: targets.flatMap((target) => {
				if (target.element.type !== "text") return [];
				const targetScope = resolveTextScopeForEntry({ scope, target });
				if (!targetScope) return [];
				return [
					{
						trackId: target.track.id,
						elementId: target.element.id,
						patch: buildScopedTextPatch({
							element: target.element,
							scope: targetScope,
							patch,
						}),
					},
				];
			}),
		});
	};
	const targets = elementsWithTracks?.length
		? elementsWithTracks
		: [{ track: { id: trackId }, element }];
	const [inTransitionId, setInTransitionId] = useState(
		element.transitions?.in?.presetId ?? "fade",
	);
	const [outTransitionId, setOutTransitionId] = useState(
		element.transitions?.out?.presetId ?? "fade",
	);
	const [inPercent, setInPercent] = useState(
		element.transitions?.in
			? Math.round(
					durationToPercent({
						element,
						duration: element.transitions.in.duration,
					}),
				)
			: DEFAULT_TRANSITION_PERCENT,
	);
	const [outPercent, setOutPercent] = useState(
		element.transitions?.out
			? Math.round(
					durationToPercent({
						element,
						duration: element.transitions.out.duration,
					}),
				)
			: DEFAULT_TRANSITION_PERCENT,
	);

	const applyTransitions = () => {
		editor.timeline.applyTextTransitionsWithSfx({
			applications: targets.flatMap((target) => {
				if (
					target.element.type === "audio" ||
					target.element.type === "effect"
				) {
					return [];
				}
				return [
					{
						trackId: target.track.id,
						elementId: target.element.id,
						presetId: inTransitionId,
						side: "in" as const,
						percent: inPercent,
					},
					{
						trackId: target.track.id,
						elementId: target.element.id,
						presetId: outTransitionId,
						side: "out" as const,
						percent: outPercent,
					},
				];
			}),
		});
	};

	const getAllTextEntries = () =>
		getDisplayTracks({ tracks: editor.scenes.getActiveScene().tracks }).flatMap(
			(track) =>
				track.type === "text"
					? track.elements.map((textElement) => ({
							trackId: track.id,
							element: textElement,
						}))
					: [],
		);

	const selectedTextEntries = targets.flatMap((target) =>
		target.element.type === "text"
			? [{ trackId: target.track.id, element: target.element }]
			: [],
	);
	const selectedOverlappingTextEntries =
		getOverlappingTextTransitionEntries(selectedTextEntries);
	const allOverlappingTextEntries =
		getOverlappingTextTransitionEntries(getAllTextEntries());

	const applyAndArrange = (entries: typeof selectedTextEntries) => {
		const overlappingEntries = getOverlappingTextTransitionEntries(entries);
		if (overlappingEntries.length < 2) return;

		editor.timeline.applyTextTransitionsWithSfx({
			applications: overlappingEntries.flatMap(({ trackId, element }) => [
				{
					trackId,
					elementId: element.id,
					presetId: inTransitionId,
					side: "in" as const,
					percent: inPercent,
				},
				{
					trackId,
					elementId: element.id,
					presetId: outTransitionId,
					side: "out" as const,
					percent: outPercent,
				},
			]),
		});

		const refreshedEntries = editor.timeline
			.getElementsWithTracks({
				elements: overlappingEntries.map(({ trackId, element }) => ({
					trackId,
					elementId: element.id,
				})),
			})
			.flatMap(({ track, element }) =>
				element.type === "text" ? [{ trackId: track.id, element }] : [],
			);
		const updates = arrangeOverlappingTextTransitions({
			entries: refreshedEntries,
		});
		if (updates.length > 0) {
			editor.timeline.updateElements({ updates });
		}
	};

	if (isScopedWordTransition) {
		const settings = getScopedSettings({ element, scope });
		const revealMode = settings.revealMode ?? "determined-by-preset";
		const transitionIn = settings.transitionIn ?? "none";
		const updateScopedTransition = (patch: TextScopedSettings) => {
			editor.timeline.updateElements({
				updates: targets.flatMap((target) => {
					if (target.element.type !== "text") return [];
					const targetScope = resolveTextScopeForEntry({ scope, target });
					if (!targetScope) return [];
					return [
						{
							trackId: target.track.id,
							elementId: target.element.id,
							patch: buildScopedTextPatch({
								element: target.element,
								scope: targetScope,
								patch,
							}),
						},
					];
				}),
			});
		};

		return (
			<Section sectionKey={`${element.id}:transitions:${scope.type}`}>
				<SectionContent className="pt-4">
					<SectionFields>
						<SectionField label="Glower">
							<Switch
								checked={glowerEnabled}
								onCheckedChange={(checked) =>
									updateGlower({ glowerEnabled: checked })
								}
							/>
						</SectionField>
						<SectionField label="Lightning Storm">
							<Switch
								checked={scopedSettings.lightningStormEnabled ?? false}
								onCheckedChange={(checked) =>
									updateGlower({ lightningStormEnabled: checked })
								}
							/>
						</SectionField>
						<SectionField label="Glitchy">
							<Switch
								checked={scopedSettings.glitchyEnabled ?? false}
								onCheckedChange={(checked) =>
									updateGlower({ glitchyEnabled: checked })
								}
							/>
						</SectionField>
						{glowerEnabled && (
							<SectionField label="Glow direction">
								<Select
									value={scopedSettings.glowerDirection ?? "auto"}
									onValueChange={(value) =>
										updateGlower({
											glowerDirection:
												value === "rtl" || value === "ltr" ? value : "auto",
										})
									}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{WORD_DIRECTIONS.map((direction) => (
											<SelectItem key={direction.value} value={direction.value}>
												{direction.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</SectionField>
						)}
						<SectionField label="Reveal">
							<Select
								value={revealMode}
								onValueChange={(value) =>
									updateScopedTransition({ revealMode: toRevealMode(value) })
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{REVEAL_MODES.map((mode) => (
										<SelectItem key={mode.value} value={mode.value}>
											{mode.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
						<SectionField label="Transition in">
							<Select
								value={transitionIn}
								onValueChange={(value) =>
									updateScopedTransition({
										transitionIn: toTransitionIn(value),
									})
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{TRANSITION_IN_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
					</SectionFields>
				</SectionContent>
			</Section>
		);
	}

	return (
		<Section sectionKey={`${element.id}:transitions`}>
			<SectionContent className="pt-4">
				<SectionFields>
					<SectionField label="Glower">
						<Switch
							checked={glowerEnabled}
							onCheckedChange={(checked) =>
								updateGlower({ glowerEnabled: checked })
							}
						/>
					</SectionField>
					<SectionField label="Lightning Storm">
						<Switch
							checked={scopedSettings.lightningStormEnabled ?? false}
							onCheckedChange={(checked) =>
								updateGlower({ lightningStormEnabled: checked })
							}
						/>
					</SectionField>
					<SectionField label="Glitchy">
						<Switch
							checked={scopedSettings.glitchyEnabled ?? false}
							onCheckedChange={(checked) =>
								updateGlower({ glitchyEnabled: checked })
							}
						/>
					</SectionField>
					{glowerEnabled && (
						<SectionField label="Glow direction">
							<Select
								value={scopedSettings.glowerDirection ?? "auto"}
								onValueChange={(value) =>
									updateGlower({
										glowerDirection:
											value === "rtl" || value === "ltr" ? value : "auto",
									})
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{WORD_DIRECTIONS.map((direction) => (
										<SelectItem key={direction.value} value={direction.value}>
											{direction.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
					)}
					<SectionField label="In transition">
						<Select value={inTransitionId} onValueChange={setInTransitionId}>
							<SelectTrigger>
								<SelectValue>
									<TransitionPresetLabel
										transitionId={inTransitionId}
										side="in"
									/>
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{TRANSITION_PRESETS.map((transition) => (
									<SelectItem key={transition.id} value={transition.id}>
										<TransitionPresetLabel
											transitionId={transition.id}
											side="in"
										/>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>
					<SectionField label="In %">
						<Input
							type="number"
							min={0}
							max={100}
							step={1}
							value={inPercent}
							onChange={(event) =>
								setInPercent(
									clampTransitionPercent(Number(event.currentTarget.value)),
								)
							}
						/>
					</SectionField>
					<SectionField label="Out transition">
						<Select value={outTransitionId} onValueChange={setOutTransitionId}>
							<SelectTrigger>
								<SelectValue>
									<TransitionPresetLabel
										transitionId={outTransitionId}
										side="out"
									/>
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{TRANSITION_PRESETS.map((transition) => (
									<SelectItem key={transition.id} value={transition.id}>
										<TransitionPresetLabel
											transitionId={transition.id}
											side="out"
										/>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>
					<SectionField label="Out %">
						<Input
							type="number"
							min={0}
							max={100}
							step={1}
							value={outPercent}
							onChange={(event) =>
								setOutPercent(
									clampTransitionPercent(Number(event.currentTarget.value)),
								)
							}
						/>
					</SectionField>
					<Button type="button" onClick={applyTransitions}>
						Apply transitions
					</Button>
					<Button
						type="button"
						variant="secondary"
						disabled={selectedOverlappingTextEntries.length < 2}
						onClick={() => applyAndArrange(selectedTextEntries)}
					>
						Apply &amp; arrange selected
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={allOverlappingTextEntries.length < 2}
						onClick={() => applyAndArrange(getAllTextEntries())}
					>
						Apply &amp; arrange all text
					</Button>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}

function TransitionPresetLabel({
	transitionId,
	side,
}: {
	transitionId: string;
	side: "in" | "out";
}) {
	const transition = TRANSITION_PRESETS.find(
		(candidate) => candidate.id === transitionId,
	);
	return (
		<span className="flex items-center gap-2">
			{hasTextTransitionSfx({ transitionId, side }) ? (
				<HugeiconsIcon
					icon={VolumeHighIcon}
					size={14}
					aria-label="Includes sound effect"
				/>
			) : null}
			{transition?.label ?? transitionId}
		</span>
	);
}

function resolveTextScopeForEntry({
	scope,
	target,
}: {
	scope: TextOverrideScope;
	target: ElementWithTrackForParams;
}): TextOverrideScope | null {
	if (scope.type !== "words") {
		return scope;
	}

	const wordIds = target.textWordIds ?? scope.wordIds;
	return wordIds.length > 0 ? { type: "words", wordIds } : null;
}
