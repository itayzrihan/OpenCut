"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEditor, useEditorMedia } from "@/editor/use-editor";
import {
	Message as UiMessage,
	LocalizedValue as UiValue,
} from "@/i18n/message";
import { localizeClientMessage } from "@/i18n/client-messages";
import { toast } from "@/i18n/toast";
import { orderPodcastTimeline } from "../order-timeline";

type Recording = { id: string; gap: string };
const MAX_SOURCES = 32;
const selectClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";

export function OrderTimelinePanel({
	onBusyChange,
	onClose,
}: {
	onBusyChange: (busy: boolean) => void;
	onClose: () => void;
}) {
	const editor = useEditor();
	const assets = useEditorMedia((instance) => instance.media.getAssets());
	const videos = assets.filter(
		(asset) =>
			asset.type === "video" && !asset.ephemeral && !asset.unifiedAngles,
	);
	const audio = assets.filter(
		(asset) => asset.type === "audio" && !asset.ephemeral,
	);
	const [angleCount, setAngleCount] = useState(1);
	const [assignments, setAssignments] = useState<Record<string, number>>({});
	const [recordings, setRecordings] = useState<Recording[]>([]);
	const [name, setName] = useState("");
	const [progress, setProgress] = useState("");
	const [busy, setBusy] = useState(false);
	const [created, setCreated] = useState(false);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);

	const selectedVideos = videos.flatMap((asset) => {
		const angle = assignments[asset.id] ?? 0;
		return angle > 0 && angle <= angleCount ? [{ asset, angle }] : [];
	});
	const selectedAudio = recordings.flatMap(({ id, gap }) => {
		const asset = audio.find((item) => item.id === id);
		return asset ? [{ asset, gap: Number(gap) }] : [];
	});
	const canOrder =
		selectedVideos.length > 0 &&
		selectedVideos.length <= MAX_SOURCES &&
		selectedVideos.every(({ asset }) => !asset.missing) &&
		selectedAudio.length > 0 &&
		selectedAudio.length === recordings.length &&
		selectedAudio.every(
			({ asset, gap }) =>
				!asset.missing && Number.isFinite(gap) && gap >= 0 && gap <= 36000,
		);

	function keepGapsForUnchangedNeighbors(
		previous: Recording[],
		next: Recording[],
	) {
		const predecessor = new Map(
			previous.map(({ id }, index) => [id, previous[index - 1]?.id]),
		);
		return next.map((recording, index) =>
			predecessor.get(recording.id) === next[index - 1]?.id
				? recording
				: { ...recording, gap: "" },
		);
	}

	function moveRecording(index: number, delta: number) {
		setRecordings((current) => {
			const next = [...current];
			const [item] = next.splice(index, 1);
			next.splice(index + delta, 0, item!);
			return keepGapsForUnchangedNeighbors(current, next);
		});
	}

	async function start() {
		if (controller.current || !canOrder) return;
		const projectId = editor.project.getActiveOrNull()?.metadata.id;
		if (!projectId) return;
		const abort = new AbortController();
		controller.current = abort;
		setBusy(true);
		onBusyChange(true);
		try {
			const { plan, missingColor } = await orderPodcastTimeline({
				audio: selectedAudio,
				videos: selectedVideos,
				name: name.trim() || localizeClientMessage("Ordered podcast"),
				onProgress: setProgress,
				signal: abort.signal,
			});
			abort.signal.throwIfAborted();
			if (editor.project.getActiveOrNull()?.metadata.id !== projectId)
				throw new Error("The active project changed during synchronization.");
			editor.command.createMulticam({ plan });
			setCreated(true);
			await editor.save.flush();
			if (missingColor.length)
				toast.warning(
					"Color correction could not be estimated for some videos",
					{
						description: missingColor.join(", "),
					},
				);
		} catch (error) {
			if (!abort.signal.aborted)
				toast.error("Could not order the timeline", {
					description: error instanceof Error ? error.message : undefined,
				});
		} finally {
			controller.current = null;
			setBusy(false);
			onBusyChange(false);
			setProgress("");
		}
	}

	if (created) {
		return (
			<div className="space-y-4">
				<p role="status">
					<UiMessage text="The editable timeline is ready." />
				</p>
				<Button onClick={onClose}>
					<UiMessage text="Open in Editor" />
				</Button>
			</div>
		);
	}
	return (
		<div className="space-y-4">
			<p className="text-sm text-muted-foreground">
				<UiMessage text="Arrange one person's camera clips against one or more audio recordings." />
			</p>
			<fieldset disabled={busy} className="space-y-5">
				<div className="grid grid-cols-2 gap-3">
					<label className="space-y-1 text-sm">
						<UiMessage text="Sequence name" />
						<Input
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
					<label className="space-y-1 text-sm">
						<UiMessage text="Number of angles" />
						<select
							className={selectClass}
							value={angleCount}
							onChange={(event) => {
								const count = Number(event.target.value);
								setAngleCount(count);
								setAssignments((current) =>
									Object.fromEntries(
										Object.entries(current).filter(
											([, angle]) => angle <= count,
										),
									),
								);
							}}
						>
							{Array.from({ length: MAX_SOURCES }, (_, index) => (
								<option key={index} value={index + 1}>
									{index + 1}
								</option>
							))}
						</select>
					</label>
				</div>
				<fieldset className="space-y-2">
					<legend className="font-medium">
						<UiMessage text="Video angles" />
					</legend>
					{videos.length === 0 && (
						<p className="text-sm text-muted-foreground">
							<UiMessage text="Import video files into Assets to assign them here." />
						</p>
					)}
					<div className="max-h-56 space-y-2 overflow-auto">
						{videos.map((asset) => (
							<label
								key={asset.id}
								className="grid grid-cols-[minmax(0,1fr)_10rem] items-center gap-3 rounded border px-3 py-2"
							>
								<span className="truncate text-sm" title={asset.name}>
									{asset.name}
								</span>
								<select
									className={selectClass}
									value={assignments[asset.id] ?? 0}
									disabled={asset.missing}
									onChange={(event) =>
										setAssignments((current) => ({
											...current,
											[asset.id]: Number(event.target.value),
										}))
									}
								>
									<option value={0}>
										{localizeClientMessage("Do not include")}
									</option>
									{Array.from({ length: angleCount }, (_, index) => (
										<option key={index} value={index + 1}>
											{localizeClientMessage("Angle {v0}", {
												v0: String(index + 1),
											})}
										</option>
									))}
								</select>
							</label>
						))}
					</div>
				</fieldset>
				<fieldset className="space-y-2">
					<legend className="font-medium">
						<UiMessage text="Master audio recordings" />
					</legend>
					<p className="text-sm text-muted-foreground">
						<UiMessage text="Put recordings in the order they were made. Leave the gap blank to infer it from continuous camera audio when available." />
					</p>
					<select
						className={selectClass}
						value=""
						disabled={recordings.length >= MAX_SOURCES}
						onChange={(event) => {
							const id = event.target.value;
							if (id) setRecordings((current) => [...current, { id, gap: "" }]);
						}}
						aria-label={localizeClientMessage("Add audio recording")}
					>
						<option value="">
							{localizeClientMessage("Add audio recording")}
						</option>
						{audio
							.filter(
								(asset) =>
									!asset.missing &&
									!recordings.some(({ id }) => id === asset.id),
							)
							.map((asset) => (
								<option key={asset.id} value={asset.id}>
									{asset.name}
								</option>
							))}
					</select>
					<ol className="max-h-64 space-y-2 overflow-auto">
						{recordings.map(({ id, gap }, index) => (
							<li key={id} className="space-y-2 rounded border px-3 py-2">
								<div className="flex items-center gap-2">
									<span className="min-w-0 flex-1 truncate text-sm">
										{index + 1}.{" "}
										{audio.find((asset) => asset.id === id)?.name ?? id}
									</span>
									<Button
										size="icon"
										variant="ghost"
										disabled={index === 0}
										aria-label={localizeClientMessage("Move audio earlier")}
										onClick={() => moveRecording(index, -1)}
									>
										<ArrowUp />
									</Button>
									<Button
										size="icon"
										variant="ghost"
										disabled={index === recordings.length - 1}
										aria-label={localizeClientMessage("Move audio later")}
										onClick={() => moveRecording(index, 1)}
									>
										<ArrowDown />
									</Button>
									<Button
										variant="ghost"
										onClick={() =>
											setRecordings((current) =>
												keepGapsForUnchangedNeighbors(
													current,
													current.filter((item) => item.id !== id),
												),
											)
										}
									>
										<UiMessage text="Remove" />
									</Button>
								</div>
								{index > 0 && (
									<label className="flex items-center gap-2 text-sm">
										<UiMessage text="Minimum gap before this file (seconds)" />
										<Input
											className="w-28"
											type="number"
											min="0"
											max="36000"
											step="any"
											value={gap}
											onChange={(event) =>
												setRecordings((current) =>
													current.map((item) =>
														item.id === id
															? { ...item, gap: event.target.value }
															: item,
													),
												)
											}
										/>
									</label>
								)}
							</li>
						))}
					</ol>
				</fieldset>
			</fieldset>
			<div className="flex flex-wrap items-center justify-end gap-2">
				{progress && (
					<p role="status" className="me-auto text-sm">
						<UiValue>{progress}</UiValue>
					</p>
				)}
				{busy ? (
					<Button variant="outline" onClick={() => controller.current?.abort()}>
						<UiMessage text="Cancel analysis" />
					</Button>
				) : (
					<Button disabled={!canOrder} onClick={() => void start()}>
						<UiMessage text="Order timeline" />
					</Button>
				)}
			</div>
		</div>
	);
}
