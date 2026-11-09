import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import { useRef } from "react";
import { useEditor, useEditorPlayback } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { HugeiconsIcon } from "@hugeicons/react";
import { DashboardSpeed02Icon } from "@hugeicons/core-free-icons";
import { buildConstantRetime, createRetimeMapping } from "@/retime";
import {
	DEFAULT_RETIME_RATE,
	MIN_RETIME_RATE,
	MAX_RETIME_RATE,
	clampRetimeRate,
	canMaintainPitch,
} from "@/retime/rate";
import type {
	AudioElement,
	SpeedInterpolation,
	SpeedKeyframe,
	VideoElement,
} from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import {
	formatNumberForDisplay,
	getFractionDigitsForStep,
	snapToStep,
} from "@/utils/math";

const INTERPOLATIONS = [
	{ value: "hold", label: "Hold" },
	{ value: "linear", label: "Linear" },
	{ value: "easeIn", label: "Ease in" },
	{ value: "easeOut", label: "Ease out" },
	{ value: "easeInOut", label: "Ease in & out" },
] satisfies { value: SpeedInterpolation; label: string }[];

const SPEED_STEP = 0.01;
const SPEED_FRACTION_DIGITS = getFractionDigitsForStep({ step: SPEED_STEP });

function rateToDisplay({ rate }: { rate: number }): string {
	return formatNumberForDisplay({
		value: rate,
		fractionDigits: SPEED_FRACTION_DIGITS,
	});
}

function parseSpeedInput({ input }: { input: string }): number | null {
	const parsed = parseFloat(input);
	if (Number.isNaN(parsed)) return null;
	return clampRetimeRate({
		rate: snapToStep({ value: parsed, step: SPEED_STEP }),
	});
}

function buildRetime({
	rate,
	maintainPitch,
}: {
	rate: number;
	maintainPitch: boolean;
}) {
	if (rate === DEFAULT_RETIME_RATE && !maintainPitch) return undefined;
	return buildConstantRetime({ rate, maintainPitch });
}

export function SpeedTab({
	element,
	trackId,
}: {
	element: AudioElement | VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const rate = clampRetimeRate({
		rate: element.retime?.rate ?? DEFAULT_RETIME_RATE,
	});
	const isPitchPreserveAvailable = canMaintainPitch({ rate });
	const maintainPitch = element.retime?.maintainPitch ?? false;
	const pendingRateRef = useRef(rate);
	const playhead = useEditorPlayback((core) => core.playback.getCurrentTime());
	const playheadOffset = playhead - element.startTime;
	const insideClip = playheadOffset >= 0 && playheadOffset <= element.duration;
	const keyframes = element.retime?.speedKeyframes ?? [];
	const hasRamp = keyframes.length > 0;
	const mapping = createRetimeMapping({
		retime: element.retime,
		trimStart: element.trimStart,
		ticks: true,
	});
	const sourceEnd =
		typeof element.sourceDuration === "number"
			? element.sourceDuration - element.trimEnd
			: Math.round(element.trimStart + mapping.sourceAt(element.duration));
	const sourceAt = (time: number) =>
		mediaTime({
			ticks: Math.max(
				element.trimStart,
				Math.min(
					sourceEnd,
					Math.round(element.trimStart + mapping.sourceAt(time)),
				),
			),
		});
	const playheadKey = sourceAt(playheadOffset);
	const updateKeys = (keys: SpeedKeyframe[]) => {
		editor.timeline.updateElementRetime({
			trackId,
			elementId: element.id,
			retime: keys.length
				? { rate, speedKeyframes: keys.sort((a, b) => a.time - b.time) }
				: buildRetime({ rate, maintainPitch: false }),
		});
	};
	const changeKey = ({
		key,
		patch,
	}: {
		key: SpeedKeyframe;
		patch: Partial<SpeedKeyframe>;
	}) => {
		updateKeys(
			keyframes.map((other) =>
				other.time === key.time ? { ...key, ...patch } : other,
			),
		);
	};
	const addKey = () => {
		if (
			!insideClip ||
			keyframes.some((key) => key.time === playheadKey) ||
			keyframes.length >= 1000
		)
			return;
		const startKey: SpeedKeyframe = {
			time: element.trimStart,
			rate,
			interpolation: "linear",
		};
		updateKeys([
			...(!hasRamp && playheadKey > element.trimStart ? [startKey] : keyframes),
			{
				time: playheadKey,
				rate: clampRetimeRate({ rate: mapping.rateAt(playheadOffset) }),
				interpolation:
					keyframes.findLast((key) => key.time < playheadKey)?.interpolation ??
					"linear",
			},
		]);
	};

	const commitRetime = ({
		rate: nextRate,
		maintainPitch: nextMaintainPitch,
	}: {
		rate: number;
		maintainPitch: boolean;
	}) => {
		editor.timeline.discardPreview();
		const committed = editor.timeline.getElementsWithTracks({
			elements: [{ trackId, elementId: element.id }],
		})[0]?.element;
		if (
			(committed?.type === "audio" || committed?.type === "video") &&
			nextRate === (committed.retime?.rate ?? DEFAULT_RETIME_RATE) &&
			nextMaintainPitch === (committed.retime?.maintainPitch ?? false)
		)
			return;
		editor.timeline.updateElementRetime({
			trackId,
			elementId: element.id,
			retime: buildRetime({ rate: nextRate, maintainPitch: nextMaintainPitch }),
		});
	};

	const speedDraft = usePropertyDraft({
		displayValue: rateToDisplay({ rate }),
		parse: (input) => parseSpeedInput({ input }),
		onPreview: (nextRate) => {
			pendingRateRef.current = nextRate;
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							retime: buildRetime({ rate: nextRate, maintainPitch }),
						},
					},
				],
			});
		},
		onCommit: () => {
			commitRetime({ rate: pendingRateRef.current, maintainPitch });
		},
	});

	return (
		<Section collapsible sectionKey={`${element.id}:speed`}>
			<SectionHeader>
				<SectionTitle>
					<UiMessage text={"Speed"} />
				</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					{!hasRamp && (
						<UiLocalized<typeof SectionField>
							element={SectionField}
							messageProps={["label"]}
							label="Speed"
						>
							<NumberField
								icon={<HugeiconsIcon icon={DashboardSpeed02Icon} />}
								value={speedDraft.displayValue}
								suffix="x"
								scrubRanges={[
									{ from: 0.01, to: 1, pixelsPerUnit: 160 },
									{ from: 1, to: 5, pixelsPerUnit: 48 },
								]}
								scrubClamp={{ min: MIN_RETIME_RATE, max: MAX_RETIME_RATE }}
								onFocus={() => {
									pendingRateRef.current = rate;
									speedDraft.onFocus();
								}}
								onChange={speedDraft.onChange}
								onBlur={speedDraft.onBlur}
								onScrub={speedDraft.scrubTo}
								onScrubEnd={speedDraft.commitScrub}
								onReset={() =>
									commitRetime({ rate: DEFAULT_RETIME_RATE, maintainPitch })
								}
								isDefault={rate === DEFAULT_RETIME_RATE}
							/>
						</UiLocalized>
					)}
					<div className="flex items-center justify-between">
						<span className="text-sm">
							<UiMessage text={"Change pitch"} />
						</span>
						<UiLocalized<typeof Switch>
							element={Switch}
							messageProps={["aria-label"]}
							checked={hasRamp || !maintainPitch}
							disabled={hasRamp || !isPitchPreserveAvailable}
							aria-label="Change pitch"
							onCheckedChange={(checked) =>
								commitRetime({ rate, maintainPitch: !checked })
							}
						/>
					</div>
					<div className="space-y-2">
						<div className="flex items-center justify-between gap-2">
							<span className="text-sm font-medium">
								<UiMessage text={"Speed keyframes"} />
							</span>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={addKey}
								disabled={
									!insideClip ||
									keyframes.length >= 1000 ||
									keyframes.some((key) => key.time === playheadKey)
								}
							>
								<UiMessage text={"Add at playhead"} />
							</Button>
						</div>
						{!hasRamp && (
							<p className="text-muted-foreground text-xs">
								<UiMessage
									text={"Place the playhead on the clip to set a speed point."}
								/>
							</p>
						)}
						{hasRamp && (
							<>
								<p className="text-muted-foreground text-xs">
									<UiMessage
										text={
											"Easing controls the transition to the next point. Audio pitch follows the speed ramp."
										}
									/>
								</p>
								{keyframes
									.filter(
										(key) =>
											key.time >= element.trimStart && key.time <= sourceEnd,
									)
									.map((key, index) => {
										const time = Math.max(
											0,
											Math.min(
												element.duration,
												mapping.clipAt(key.time - element.trimStart),
											),
										);
										const label = `Speed keyframe ${index + 1}`;
										const seconds = Number(
											(time / TICKS_PER_SECOND).toFixed(4),
										);
										return (
											<div
												key={key.time}
												className="grid grid-cols-[1fr_1fr_auto] items-center gap-1"
											>
												<button
													type="button"
													className="text-left text-xs tabular-nums hover:underline"
													aria-label={`Go to ${label.toLowerCase()}`}
													onClick={() =>
														editor.playback.seek({
															time: mediaTime({
																ticks: Math.round(element.startTime + time),
															}),
														})
													}
												>
													{seconds}s
												</button>
												<input
													key={key.rate}
													type="number"
													min={MIN_RETIME_RATE}
													max={MAX_RETIME_RATE}
													step={SPEED_STEP}
													defaultValue={rateToDisplay({ rate: key.rate })}
													aria-label={`${label} rate`}
													className="bg-background border-input min-w-0 rounded border px-1.5 py-1 text-xs"
													onKeyDown={(event) => {
														if (event.key === "Enter")
															event.currentTarget.blur();
													}}
													onBlur={(event) => {
														const next = parseSpeedInput({
															input: event.currentTarget.value,
														});
														event.currentTarget.value = rateToDisplay({
															rate: next ?? key.rate,
														});
														if (
															next !== null &&
															rateToDisplay({ rate: next }) !==
																rateToDisplay({ rate: key.rate })
														)
															changeKey({ key, patch: { rate: next } });
													}}
												/>
												<Button
													type="button"
													size="sm"
													variant="ghost"
													aria-label={`Remove ${label.toLowerCase()}`}
													onClick={() =>
														updateKeys(
															keyframes.filter(
																(point) => point.time !== key.time,
															),
														)
													}
												>
													×
												</Button>
												<select
													aria-label={`${label} easing`}
													value={key.interpolation}
													className="bg-background border-input col-span-2 rounded border px-1.5 py-1 text-xs"
													onChange={(event) => {
														const selected = INTERPOLATIONS.find(
															(option) =>
																option.value === event.currentTarget.value,
														);
														if (selected)
															changeKey({
																key,
																patch: { interpolation: selected.value },
															});
													}}
												>
													{INTERPOLATIONS.map(({ value, label }) => (
														<option key={value} value={value}>
															{label}
														</option>
													))}
												</select>
											</div>
										);
									})}
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onClick={() => updateKeys([])}
								>
									<UiMessage text={"Clear speed keyframes"} />
								</Button>
							</>
						)}
					</div>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
