"use client";

import { Button } from "@/components/ui/button";
import type { AiEditOperation, AiEditPlan } from "@/ai/types";

export function AiPlanReview({
	plan,
	errors = [],
	isApplying,
	onApply,
	onDiscard,
}: {
	plan: AiEditPlan | null;
	errors?: string[];
	isApplying?: boolean;
	onApply: () => void;
	onDiscard: () => void;
}) {
	const uniqueErrors = getUniqueMessages(errors);

	if (!plan) {
		if (uniqueErrors.length === 0) {
			return null;
		}
		return (
			<div className="border-t pt-3">
				<div className="text-sm font-medium">The AI plan was rejected</div>
				<div className="border-destructive/40 bg-destructive/10 text-destructive mt-2 max-h-40 overflow-y-auto rounded-sm border p-2 text-xs leading-5">
					{uniqueErrors.map((error) => (
						<div key={error}>{error}</div>
					))}
				</div>
				<div className="text-muted-foreground mt-2 text-xs">
					The returned plan failed validation against the current timeline. Send
					the request again.
				</div>
			</div>
		);
	}
	const uniqueNotes = getUniqueMessages(plan.notes ?? []);

	return (
		<div className="border-t pt-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="text-sm font-medium">{plan.title}</div>
					<div className="text-muted-foreground mt-1 text-xs leading-5">
						{plan.summary || "No summary returned."}
					</div>
				</div>
				<div className="text-muted-foreground shrink-0 text-xs">
					{plan.operations.length} ops
				</div>
			</div>

			{uniqueErrors.length > 0 && (
				<div className="border-destructive/40 bg-destructive/10 text-destructive mt-3 rounded-sm border p-2 text-xs leading-5">
					{uniqueErrors.map((error) => (
						<div key={error}>{error}</div>
					))}
				</div>
			)}
			{uniqueNotes.length > 0 && (
				<div className="mt-3 rounded-sm border border-amber-500/30 bg-amber-500/10 p-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
					{uniqueNotes.map((note) => (
						<div key={note}>{note}</div>
					))}
				</div>
			)}

			<div className="mt-3 max-h-40 overflow-y-auto rounded-sm border">
				{plan.operations.length === 0 ? (
					<div className="text-muted-foreground p-3 text-xs">
						No timeline edits proposed.
					</div>
				) : (
					plan.operations.map((operation, index) => (
						<div
							key={`${operation.type}-${index}`}
							className="border-b px-3 py-2 last:border-b-0"
						>
							<div className="text-xs font-medium">
								{getOperationTitle({ operation })}
							</div>
							<div className="text-muted-foreground mt-1 text-xs">
								{getOperationTarget({ operation })}
							</div>
							{"reason" in operation && operation.reason && (
								<div className="text-muted-foreground mt-1 text-xs">
									{operation.reason}
								</div>
							)}
							{operation.type === "insert_html_element" && (
								<pre className="bg-muted/40 mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap rounded-sm p-2 text-[11px] leading-4">
									{operation.html.length > 600
										? `${operation.html.slice(0, 600)}...`
										: operation.html}
								</pre>
							)}
							{operation.type === "update_element" && (
								<pre className="bg-muted/40 mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap rounded-sm p-2 text-[11px] leading-4">
									{JSON.stringify(operation.patch, null, 2)}
								</pre>
							)}
							{operation.type === "attach_custom_edit" && (
								<>
									{operation.startTime !== undefined &&
										operation.duration !== undefined && (
											<div className="text-muted-foreground mt-1 text-xs">
												layer {operation.startTime} -{" "}
												{operation.startTime + operation.duration} ticks
											</div>
										)}
									<pre className="bg-muted/40 mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap rounded-sm p-2 text-[11px] leading-4">
										{formatCustomEditSpec({ operation })}
									</pre>
								</>
							)}
						</div>
					))
				)}
			</div>

			<div className="mt-3 flex justify-end gap-2">
				<Button variant="outline" size="sm" onClick={onDiscard}>
					Discard
				</Button>
				<Button
					size="sm"
					onClick={onApply}
					disabled={errors.length > 0 || isApplying}
				>
					{isApplying ? "Applying..." : "Apply"}
				</Button>
			</div>
		</div>
	);
}

function getUniqueMessages(messages: string[]): string[] {
	return [...new Set(messages)];
}

function getOperationTitle({
	operation,
}: {
	operation: AiEditOperation;
}): string {
	switch (operation.type) {
		case "apply_timeline_source_v2":
			return "Apply full Timeline Source v2";
		case "attach_custom_edit":
			return `${operation.label} (${operation.kind ?? "custom"})`;
		case "add_clip_effect":
			return `Add ${operation.effectType} clip effect`;
		case "update_clip_effect_params":
			return `Update clip effect ${operation.effectId}`;
		case "remove_clip_effect":
			return `Remove clip effect ${operation.effectId}`;
		case "set_clip_effect_enabled":
			return `${operation.enabled ? "Enable" : "Disable"} clip effect ${operation.effectId}`;
		case "reorder_clip_effect":
			return `Move clip effect ${operation.fromIndex} → ${operation.toIndex}`;
		case "set_background_removal":
			return operation.enabled
				? `Enable ${operation.mode ?? "remove"} background processing`
				: "Disable background removal";
		case "insert_text_element":
			return "Insert text element";
		case "update_element":
			return "Update element";
		case "trim_element":
			return "Trim element";
		case "move_element":
			return "Move element";
		case "split_element":
			return "Split element";
		case "delete_element":
			return "Delete element";
		case "upsert_keyframe":
			return "Upsert keyframe";
		case "remove_keyframe":
			return "Remove keyframe";
		case "add_track":
			return `Add ${operation.trackType} track`;
		case "remove_track":
			return "Remove track";
		case "reorder_track":
			return `Reorder track to index ${operation.toIndex}`;
		case "set_track_state":
			return `Set track ${describeStateFlags({
				hidden: operation.hidden,
				muted: operation.muted,
			})}`;
		case "create_scene":
			return `Create scene: ${operation.name}`;
		case "rename_scene":
			return `Rename scene to ${operation.name}`;
		case "delete_scene":
			return "Delete scene";
		case "set_project_settings":
			return "Update project settings";
		case "add_bookmark":
			return "Add bookmark";
		case "update_bookmark":
			return "Update bookmark";
		case "remove_bookmark":
			return "Remove bookmark";
		case "move_bookmark":
			return "Move bookmark";
		case "start_export_task":
			return `Start ${operation.format.toUpperCase()} export (${operation.quality.replaceAll("_", " ")})`;
		case "start_transcription_task":
			return `Generate captions${operation.language ? ` (${operation.language})` : ""}`;
		case "insert_media_element":
			return "Insert media element";
		case "insert_library_audio_element":
			return `Insert shared audio: ${operation.name}`;
		case "insert_graphic_element":
			return `Insert ${operation.definitionId} graphic`;
		case "insert_html_element":
			return `Insert HTML frame${operation.name ? `: ${operation.name}` : ""}`;
		case "insert_sticker_element":
			return `Insert sticker${operation.name ? `: ${operation.name}` : ""}`;
		case "insert_effect_element":
			return `Insert ${operation.effectType} effect layer`;
		case "duplicate_element":
			return "Duplicate element";
		case "apply_transition":
			return `Apply ${operation.presetId} transition (${operation.side})`;
		case "set_element_state":
			return `Set element ${describeStateFlags({
				hidden: operation.hidden,
				muted: operation.muted,
			})}`;
		case "retime_element":
			return `Retime element to ${operation.rate}x`;
		default: {
			const exhaustive: never = operation;
			return exhaustive;
		}
	}
}

function describeStateFlags({
	hidden,
	muted,
}: {
	hidden?: boolean;
	muted?: boolean;
}): string {
	const parts: string[] = [];
	if (hidden !== undefined) {
		parts.push(hidden ? "hidden" : "visible");
	}
	if (muted !== undefined) {
		parts.push(muted ? "muted" : "unmuted");
	}
	return parts.join(", ") || "state";
}

function getOperationTarget({
	operation,
}: {
	operation: AiEditOperation;
}): string {
	if (operation.type === "apply_timeline_source_v2") {
		return operation.scope
			? `active scene range ${operation.scope.startTime}–${operation.scope.endTime} ticks`
			: "complete active scene and project settings";
	}
	if (operation.type === "add_track") {
		return operation.index !== undefined
			? `new ${operation.trackType} track at index ${operation.index}`
			: `new ${operation.trackType} track`;
	}
	if (
		operation.type === "remove_track" ||
		operation.type === "reorder_track" ||
		operation.type === "set_track_state"
	) {
		return `track ${operation.trackId}`;
	}
	if (operation.type === "create_scene") {
		return "new secondary scene";
	}
	if (operation.type === "rename_scene" || operation.type === "delete_scene") {
		return `scene ${operation.sceneId}`;
	}
	if (operation.type === "set_project_settings") {
		return "active project";
	}
	if (
		operation.type === "add_bookmark" ||
		operation.type === "update_bookmark" ||
		operation.type === "remove_bookmark"
	) {
		return `active scene at ${operation.time} ticks`;
	}
	if (operation.type === "move_bookmark") {
		return `active scene ${operation.fromTime} → ${operation.toTime} ticks`;
	}
	if (operation.type === "start_export_task") {
		return `active project; audio ${operation.includeAudio === false ? "excluded" : "included"}`;
	}
	if (operation.type === "start_transcription_task") {
		return "active scene timeline audio; captions will be inserted when complete";
	}
	if (
		operation.type === "insert_text_element" ||
		operation.type === "insert_media_element" ||
		operation.type === "insert_library_audio_element" ||
		operation.type === "insert_graphic_element" ||
		operation.type === "insert_html_element" ||
		operation.type === "insert_sticker_element" ||
		operation.type === "insert_effect_element"
	) {
		return operation.trackId
			? `track ${operation.trackId}`
			: "auto-placed on a compatible layer";
	}
	if (operation.type === "move_element") {
		return `${operation.sourceTrackId}:${operation.elementId} -> ${operation.targetTrackId}`;
	}
	return `${operation.trackId}:${operation.elementId}`;
}

function formatCustomEditSpec({
	operation,
}: {
	operation: Extract<AiEditOperation, { type: "attach_custom_edit" }>;
}): string {
	const payload = {
		intent: operation.intent,
		spec: operation.spec,
	};
	return JSON.stringify(payload, null, 2);
}
