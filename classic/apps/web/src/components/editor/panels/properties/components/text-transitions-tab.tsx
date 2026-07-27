"use client";

import { useMemo, useState } from "react";
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
import {
	DEFAULT_TRANSITION_PERCENT,
	TRANSITION_PRESETS,
	clampTransitionPercent,
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
				return [{
					trackId: target.track.id,
					elementId: target.element.id,
					patch: buildScopedTextPatch({
						element: target.element,
						scope: targetScope,
						patch,
					}),
				}];
			}),
		});
	};
	const targets = useMemo(
		() =>
			elementsWithTracks?.length
				? elementsWithTracks
				: [{ track: { id: trackId }, element }],
		[elementsWithTracks, trackId, element],
	);
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
		editor.timeline.applyTransitions({
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
												value === "rtl" || value === "ltr"
													? value
													: "auto",
										})
									}
								>
									<SelectTrigger><SelectValue /></SelectTrigger>
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
								<SelectTrigger><SelectValue /></SelectTrigger>
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
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{TRANSITION_PRESETS.map((transition) => (
									<SelectItem key={transition.id} value={transition.id}>
										{transition.label}
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
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{TRANSITION_PRESETS.map((transition) => (
									<SelectItem key={transition.id} value={transition.id}>
										{transition.label}
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
				</SectionFields>
			</SectionContent>
		</Section>
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
