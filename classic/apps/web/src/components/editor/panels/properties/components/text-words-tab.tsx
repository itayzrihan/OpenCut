"use client";

import { Button } from "@/components/ui/button";
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
import type { TextElement } from "@/timeline";
import {
	CAPTION_ACCENT_COLORS,
	CAPTION_WORD_ANIMATIONS,
} from "@/text/caption-presets";
import {
	buildTextLineBreakPatch,
	type TextLineBreakAction,
} from "@/text/text-layer-utils";
import type { ElementWithTrackForParams } from "./element-params-tab";
import {
	buildScopedTextPatch,
	clearScopedTextOverride,
	getScopedSettings,
	getWordRuns,
	hasScopedTextOverride,
	type TextOverrideScope,
	type TextScopedSettings,
} from "../text-scope";
import {
	REVEAL_MODES,
	TRANSITION_IN_OPTIONS,
	WORD_DIRECTIONS,
	toRevealMode,
	toTransitionIn,
	toWordDirection,
	usesTransitionIn,
} from "../text-word-controls";

export function TextWordsTab({
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
	const bulkTextEntries = (elementsWithTracks ?? []).filter(
		(entry): entry is ElementWithTrackForParams & { element: TextElement } =>
			entry.element.type === "text",
	);
	const isBulk = bulkTextEntries.length > 1;
	const isBulkWordScope = isBulk && scope.type === "words";
	const effectiveScope =
		isBulk && !isBulkWordScope ? ({ type: "layer" } as const) : scope;
	const wordRuns = getWordRuns({ element });
	const lineRows = buildLineRows({ wordRuns });
	const canEditLineBreaks = !isBulk && wordRuns.length > 1;
	const settings = getScopedSettings({ element, scope: effectiveScope });
	const values = {
		wordAnimationId:
			settings.wordAnimationId ?? CAPTION_WORD_ANIMATIONS[0]?.id ?? "",
		revealMode: settings.revealMode ?? "determined-by-preset",
		transitionIn: settings.transitionIn ?? "none",
		accentColor: settings.accentColor ?? CAPTION_ACCENT_COLORS[0]?.value ?? "",
		wordDirection: settings.wordDirection ?? "auto",
	};
	const hasOverride =
		effectiveScope.type !== "layer" &&
		hasScopedTextOverride({ element, scope: effectiveScope });

	const applyPatchToElement = ({
		targetElement,
		scope,
		patch,
	}: {
		targetElement: TextElement;
		scope: TextOverrideScope;
		patch: TextScopedSettings;
	}) => {
		const scopedPatch = buildScopedTextPatch({
			element: targetElement,
			scope,
			patch,
		});
		if (scope.type === "layer") {
			return {
				...scopedPatch,
				wordRuns: getWordRuns({ element: targetElement }),
			};
		}
		return scopedPatch;
	};

	const updateScopedSettings = (patch: TextScopedSettings) => {
		if (isBulk) {
			editor.timeline.updateElements({
				updates: bulkTextEntries.flatMap((entry) => {
					const entryScope = isBulkWordScope
						? resolveTextScopeForEntry({ scope, entry })
						: ({ type: "layer" } as const);
					if (!entryScope) return [];
					return [
						{
							trackId: entry.track.id,
							elementId: entry.element.id,
							patch: applyPatchToElement({
								targetElement: entry.element,
								scope: entryScope,
								patch,
							}),
						},
					];
				}),
			});
			return;
		}

		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: applyPatchToElement({
						targetElement: element,
						scope: effectiveScope,
						patch,
					}),
				},
			],
		});
	};

	const clearOverride = () => {
		if (effectiveScope.type === "layer") return;
		if (effectiveScope.type === "words" && isBulkWordScope) {
			editor.timeline.updateElements({
				updates: bulkTextEntries.flatMap((entry) => {
					const entryScope = resolveTextScopeForEntry({ scope, entry });
					if (!entryScope) return [];
					return [
						{
							trackId: entry.track.id,
							elementId: entry.element.id,
							patch: clearScopedTextOverride({
								element: entry.element,
								scope: entryScope,
							}),
						},
					];
				}),
			});
			return;
		}
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: clearScopedTextOverride({
						element,
						scope: effectiveScope,
					}),
				},
			],
		});
	};
	const updateLineBreak = ({
		wordId,
		action,
	}: {
		wordId: string;
		action: TextLineBreakAction;
	}) => {
		const patch = buildTextLineBreakPatch({ element, wordId, action });
		if (!patch) return;
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch,
				},
			],
		});
	};

	return (
		<Section sectionKey={`${element.id}:words`}>
			<SectionContent className="pt-4">
				<SectionFields>
					{canEditLineBreaks && (
						<SectionField label="Line breaks">
							<div className="flex flex-col gap-2">
								{lineRows.map((row, rowIndex) => (
									<div
										key={row.lineIndex}
										className="border-border bg-input/30 rounded-sm border px-2 py-2"
									>
										<div className="text-muted-foreground mb-1.5 text-xs">
											Line {rowIndex + 1}
										</div>
										<div className="flex flex-wrap gap-1.5">
											{row.words.map((word) => {
												const isFirstWord = word.index === 0;
												const isFirstWordInRow =
													word.index === row.words[0]?.index;
												const action: TextLineBreakAction =
													isFirstWordInRow && rowIndex > 0
														? "join-previous"
														: "start-line";
												return (
													<button
														key={word.id}
														type="button"
														disabled={isFirstWord}
														title={
															action === "join-previous"
																? "Join with previous line"
																: "Start line here"
														}
														className="border-border bg-background hover:bg-accent disabled:text-muted-foreground disabled:hover:bg-background focus-visible:ring-ring max-w-full rounded-full border px-2.5 py-1 text-xs outline-none focus-visible:ring-2 disabled:cursor-default disabled:opacity-70"
														onClick={() =>
															updateLineBreak({
																wordId: word.id,
																action,
															})
														}
													>
														<span className="block max-w-28 truncate">
															{word.text}
														</span>
													</button>
												);
											})}
										</div>
									</div>
								))}
							</div>
						</SectionField>
					)}

					<SectionField label="Word animation">
						<Select
							value={values.wordAnimationId}
							onValueChange={(wordAnimationId) =>
								updateScopedSettings(
									wordAnimationId === "none"
										? {
												wordAnimationId,
												revealMode: "determined-by-preset",
												transitionIn: "none",
											}
										: { wordAnimationId },
								)
							}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{CAPTION_WORD_ANIMATIONS.map((animation) => (
									<SelectItem key={animation.id} value={animation.id}>
										{animation.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>

					<SectionField label="Reveal">
						<Select
							value={values.revealMode}
							onValueChange={(revealMode) =>
								updateScopedSettings({
									revealMode: toRevealMode(revealMode),
								})
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

					{usesTransitionIn(values.revealMode) && (
						<SectionField label="Transition in">
							<Select
								value={values.transitionIn}
								onValueChange={(transitionIn) =>
									updateScopedSettings({
										transitionIn: toTransitionIn(transitionIn),
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
					)}

					<SectionField label="Accent">
						<Select
							value={values.accentColor}
							onValueChange={(accentColor) =>
								updateScopedSettings({ accentColor })
							}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{CAPTION_ACCENT_COLORS.map((color) => (
									<SelectItem key={color.value} value={color.value}>
										{color.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>

					<SectionField label="Direction">
						<Select
							value={values.wordDirection}
							onValueChange={(wordDirection) =>
								updateScopedSettings({
									wordDirection: toWordDirection(wordDirection),
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

					{(!element.wordRuns?.length || (isBulk && !isBulkWordScope)) && (
						<Button
							type="button"
							variant="outline"
							onClick={() => updateScopedSettings({})}
						>
							{isBulk
								? "Apply word controls to selected layers"
								: "Enable word controls"}
						</Button>
					)}

					{effectiveScope.type !== "layer" && (
						<Button
							type="button"
							variant="outline"
							disabled={!hasOverride}
							onClick={clearOverride}
						>
							Clear {effectiveScope.type} override
						</Button>
					)}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}

function resolveTextScopeForEntry({
	scope,
	entry,
}: {
	scope: TextOverrideScope;
	entry: ElementWithTrackForParams & { element: TextElement };
}): TextOverrideScope | null {
	if (scope.type !== "words") {
		return scope;
	}

	const wordIds = entry.textWordIds ?? scope.wordIds;
	return wordIds.length > 0 ? { type: "words", wordIds } : null;
}

function buildLineRows({ wordRuns }: { wordRuns: ReturnType<typeof getWordRuns> }) {
	const rows = new Map<
		number,
		Array<{ id: string; text: string; index: number }>
	>();
	wordRuns.forEach((word, index) => {
		const lineIndex = word.lineIndex ?? 0;
		rows.set(lineIndex, [
			...(rows.get(lineIndex) ?? []),
			{ id: word.id, text: word.text, index },
		]);
	});
	return [...rows.entries()]
		.sort(([left], [right]) => left - right)
		.map(([lineIndex, words]) => ({ lineIndex, words }));
}
