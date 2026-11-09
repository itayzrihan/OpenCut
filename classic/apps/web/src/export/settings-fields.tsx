"use client";
import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { ExportOptions, ExportPlan } from "@/export";
export type ExportSettingsValue = Pick<
	Required<ExportOptions>,
	"format" | "quality" | "preferences" | "includeAudio"
>;
export function ExportSettingsFields({
	value,
	onChange,
	disabled = false,
}: {
	value: ExportSettingsValue;
	onChange: (next: ExportSettingsValue) => void;
	disabled?: boolean;
}) {
	const id = useId();
	const selectClass = "bg-background border rounded p-2 text-sm min-w-0";
	return (
		<div className="space-y-3 text-sm">
			<div className="grid grid-cols-2 gap-3">
				<label className="grid gap-1">
					<UiMessage text={"Format"} />
					<UiLocalized<"select">
						element={"select"}
						messageProps={["aria-label"]}
						aria-label="Export format"
						disabled={disabled}
						className={selectClass}
						value={value.format}
						onChange={(e) =>
							onChange({
								...value,
								format: e.target.value as ExportSettingsValue["format"],
							})
						}
					>
						<option value="mp4">MP4</option>
						<UiLocalized<"option">
							element={"option"}
							messageProps={["children"]}
							value="webm"
						>
							{"WebM (VP9)"}
						</UiLocalized>
					</UiLocalized>
				</label>
				<label className="grid gap-1">
					<UiMessage text={"Quality"} />
					<UiLocalized<"select">
						element={"select"}
						messageProps={["aria-label"]}
						aria-label="Export quality"
						disabled={disabled}
						className={selectClass}
						value={value.quality}
						onChange={(e) =>
							onChange({
								...value,
								quality: e.target.value as ExportSettingsValue["quality"],
							})
						}
					>
						<UiLocalized<"option">
							element={"option"}
							messageProps={["children"]}
							value="low"
						>
							{"Low · Smallest file"}
						</UiLocalized>
						<UiLocalized<"option">
							element={"option"}
							messageProps={["children"]}
							value="medium"
						>
							{"Medium · Balanced"}
						</UiLocalized>
						<UiLocalized<"option">
							element={"option"}
							messageProps={["children"]}
							value="high"
						>
							{"High · Recommended"}
						</UiLocalized>
						<UiLocalized<"option">
							element={"option"}
							messageProps={["children"]}
							value="very_high"
						>
							{"Very high · Largest file"}
						</UiLocalized>
					</UiLocalized>
				</label>
				<label className="grid gap-1">
					<UiMessage text={"Resolution"} />
					<UiLocalized<"select">
						element={"select"}
						messageProps={["aria-label"]}
						aria-label="Export resolution"
						disabled={disabled}
						className={selectClass}
						value={value.preferences.resolution}
						onChange={(e) =>
							onChange({
								...value,
								preferences: {
									...value.preferences,
									resolution: e.target.value as "source" | "project",
								},
							})
						}
					>
						<UiLocalized<"option">
							element={"option"}
							messageProps={["children"]}
							value="source"
						>
							{"Source · Smart resolution"}
						</UiLocalized>
						<UiLocalized<"option">
							element={"option"}
							messageProps={["children"]}
							value="project"
						>
							{"Project resolution"}
						</UiLocalized>
					</UiLocalized>
				</label>
				{value.format === "mp4" && (
					<label className="grid gap-1">
						<UiMessage text={"Encoding"} />
						<UiLocalized<"select">
							element={"select"}
							messageProps={["aria-label"]}
							aria-label="Export encoding"
							disabled={disabled}
							className={selectClass}
							value={value.preferences.encoding}
							onChange={(e) =>
								onChange({
									...value,
									preferences: {
										...value.preferences,
										encoding: e.target.value as "compact" | "compatible",
									},
								})
							}
						>
							<UiLocalized<"option">
								element={"option"}
								messageProps={["children"]}
								value="compact"
							>
								{"Compact · HEVC (H.265)"}
							</UiLocalized>
							<UiLocalized<"option">
								element={"option"}
								messageProps={["children"]}
								value="compatible"
							>
								{"Compatible · H.264"}
							</UiLocalized>
						</UiLocalized>
					</label>
				)}
			</div>
			<div className="flex items-center gap-2">
				<Checkbox
					id={id}
					disabled={disabled}
					checked={value.includeAudio}
					onCheckedChange={(checked) =>
						onChange({ ...value, includeAudio: checked === true })
					}
				/>
				<Label htmlFor={id}>
					<UiMessage text={"Include audio in export"} />
				</Label>
			</div>
		</div>
	);
}
export function ExportPlanSummary({ plan }: { plan: ExportPlan }) {
	return (
		<UiLocalized<"div">
			element={"div"}
			messageProps={["aria-label"]}
			aria-label="Export output summary"
			className="text-xs text-muted-foreground space-y-1"
		>
			<p className="font-medium text-foreground">
				{plan.width} × {plan.height} · {plan.codec.toUpperCase()} ·{" "}
				{(plan.videoBitrate / 1000000).toFixed(1)} <UiMessage text={"Mbps"} />
			</p>
			<p>
				<UiMessage text={"Estimated size:"} />{" "}
				{(plan.estimatedBytes / 1000000000).toFixed(2)}{" "}
				<UiMessage text={"GB · actual size varies."} />
			</p>
			{plan.warnings.map((w) => (
				<p key={w}>{w}</p>
			))}
			{plan.upscaledSources.length > 0 && (
				<details>
					<summary>
						{plan.upscaledSources.length}{" "}
						<UiMessage text={"sources may be enlarged"} />
					</summary>
					{plan.upscaledSources.map((s) => (
						<p key={s}>{s}</p>
					))}
				</details>
			)}
			{plan.codec === "hevc" && (
				<p>
					<UiMessage
						text={"HEVC makes smaller files; older players may need H.264."}
					/>
				</p>
			)}
		</UiLocalized>
	);
}
