"use client";

import { Message as UiMessage } from "@/i18n/message";
import { useId } from "react";
import {
	BROWSER_TRANSCRIPTION_LABELS,
	BROWSER_TRANSCRIPTION_MODELS,
	DEFAULT_BROWSER_TRANSCRIPTION_MODEL,
	type BrowserTranscriptionModel,
} from "@/transcription/models";

export function BrowserTranscriptionPicker({
	value = DEFAULT_BROWSER_TRANSCRIPTION_MODEL,
	onChange,
	disabled,
}: {
	value?: BrowserTranscriptionModel;
	onChange: (model: BrowserTranscriptionModel) => void;
	disabled?: boolean;
}) {
	const id = useId();
	return (
		<div className="grid content-start gap-2 rounded-xl border bg-background/40 p-4">
			<label className="text-sm font-semibold" htmlFor={id}>
				<UiMessage text={"Transcription model"} />
			</label>
			<select
				id={id}
				aria-describedby={`${id}-hint`}
				value={value}
				disabled={disabled}
				onChange={(event) => {
					const model = BROWSER_TRANSCRIPTION_MODELS.find(
						(option) => option === event.currentTarget.value,
					);
					if (model) onChange(model);
				}}
				className="min-h-10 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
			>
				{BROWSER_TRANSCRIPTION_MODELS.map((model) => (
					<option key={model} value={model}>
						{BROWSER_TRANSCRIPTION_LABELS[model]}
						{model === DEFAULT_BROWSER_TRANSCRIPTION_MODEL ? (
							<>
								{" "}
								<UiMessage text={"· Hebrew"} />
							</>
						) : (
							<>
								{" "}
								<UiMessage text={"· Multilingual"} />
							</>
						)}
					</option>
				))}
			</select>
			<p
				id={`${id}-hint`}
				className="text-xs leading-relaxed text-muted-foreground"
			>
				{value === DEFAULT_BROWSER_TRANSCRIPTION_MODEL ? (
					<UiMessage text={"Tuned for Hebrew speech. Runs in your browser."} />
				) : (
					<UiMessage
						text={
							"Detects the spoken language automatically. Runs in your browser."
						}
					/>
				)}
			</p>
		</div>
	);
}
