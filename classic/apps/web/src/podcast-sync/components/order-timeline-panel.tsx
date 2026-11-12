"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import {
	ArrowDown,
	ArrowUp,
	AudioLines,
	Film,
	GripVertical,
	Plus,
	X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEditor, useEditorMedia } from "@/editor/use-editor";
import {
	Message as UiMessage,
	LocalizedValue as UiValue,
} from "@/i18n/message";
import { localizeClientMessage } from "@/i18n/client-messages";
import { toast } from "@/i18n/toast";
import { useInterfaceLanguage } from "@/i18n/provider";
import { interfaceDirection } from "@/i18n/locales";
import { cn } from "@/utils/ui";
import { orderPodcastTimeline } from "../order-timeline";

type Recording = { id: string; gap: string };
type Destination = "audio" | number;
const DRAG_TYPE = "application/x-pocut-order-timeline";
const MAX_SOURCES = 32;
const selectClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";
const dropAreaClass =
	"rounded-lg border border-dashed border-border bg-background/40 p-3 transition-colors";
const tileClass =
	"flex w-full min-w-0 items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-start";

export function OrderTimelinePanel({
	onBusyChange,
	onClose,
}: {
	onBusyChange: (busy: boolean) => void;
	onClose: () => void;
}) {
	const editor = useEditor();
	const { locale, t } = useInterfaceLanguage();
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
	const [selected, setSelected] = useState<string | null>(null);
	const [dragging, setDragging] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	const [progress, setProgress] = useState("");
	const [busy, setBusy] = useState(false);
	const [created, setCreated] = useState(false);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);

	const sourceAssets = [...videos, ...audio];
	const sourceById = new Map(sourceAssets.map((asset) => [asset.id, asset]));
	const selectedVideos = videos.flatMap((asset) => {
		const angle = assignments[asset.id] ?? 0;
		return angle > 0 && angle <= angleCount ? [{ asset, angle }] : [];
	});
	const selectedAudio = recordings.flatMap(({ id, gap }) => {
		const asset = sourceById.get(id);
		return asset ? [{ asset, gap: Number(gap) }] : [];
	});
	const canOrder =
		selectedVideos.length > 0 &&
		selectedVideos.length <= MAX_SOURCES &&
		selectedVideos.every(({ asset }) => !asset.missing) &&
		selectedAudio.length > 0 &&
		selectedAudio.length <= MAX_SOURCES &&
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

	function angleLabel(angle: number) {
		return t("Angle {v0}", { v0: String(angle) });
	}

	function canPlace(id: string | null, destination: Destination) {
		const asset = id ? sourceById.get(id) : undefined;
		if (busy || !asset || asset.missing) return false;
		if (destination === "audio")
			return (
				asset.type === "audio" &&
				(recordings.length < MAX_SOURCES ||
					recordings.some((item) => item.id === id))
			);
		return (
			asset.type === "video" &&
			destination >= 1 &&
			destination <= angleCount &&
			(selectedVideos.length < MAX_SOURCES || Boolean(assignments[asset.id]))
		);
	}

	function placeAsset(id: string, destination: Destination, before?: string) {
		if (!canPlace(id, destination)) return;
		if (destination === "audio") {
			if (id === before) return;
			setRecordings((current) => {
				const item = current.find((recording) => recording.id === id) ?? {
					id,
					gap: "",
				};
				const next = current.filter((recording) => recording.id !== id);
				const index = next.findIndex((recording) => recording.id === before);
				next.splice(index === -1 ? next.length : index, 0, item);
				return keepGapsForUnchangedNeighbors(current, next);
			});
		} else {
			setAssignments((current) => ({ ...current, [id]: destination }));
		}
		setSelected(null);
	}

	function dragEnd() {
		setDragging(null);
		setDropTarget(null);
	}

	function dragProps(id: string) {
		return {
			draggable: !busy && !sourceById.get(id)?.missing,
			onDragStart: (event: DragEvent<HTMLElement>) => {
				if (busy || sourceById.get(id)?.missing) {
					event.preventDefault();
					return;
				}
				event.dataTransfer.setData(DRAG_TYPE, id);
				event.dataTransfer.effectAllowed = "copyMove";
				setDragging(id);
			},
			onDragEnd: dragEnd,
		};
	}

	function dropProps(destination: Destination, before?: string) {
		const key = before ? `audio-${before}` : String(destination);
		return {
			onDragOver: (event: DragEvent<HTMLElement>) => {
				if (
					!event.dataTransfer.types.includes(DRAG_TYPE) ||
					!canPlace(dragging, destination)
				)
					return;
				event.preventDefault();
				event.stopPropagation();
				event.dataTransfer.dropEffect = "move";
				setDropTarget(key);
			},
			onDragLeave: (event: DragEvent<HTMLElement>) => {
				if (
					!(event.relatedTarget instanceof Node) ||
					!event.currentTarget.contains(event.relatedTarget)
				)
					setDropTarget((current) => (current === key ? null : current));
			},
			onDrop: (event: DragEvent<HTMLElement>) => {
				if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
				event.preventDefault();
				event.stopPropagation();
				const id = event.dataTransfer.getData(DRAG_TYPE);
				if (id === dragging) placeAsset(id, destination, before);
				dragEnd();
			},
		};
	}

	function removeVideo(id: string) {
		setAssignments((current) => {
			const next = { ...current };
			delete next[id];
			return next;
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
			setProgress(t("Checking source file durations…"));
			const { assets: sources, durations } =
				await editor.media.prepareMediaDurations({
					projectId,
					mediaIds: [...selectedAudio, ...selectedVideos].map(
						({ asset }) => asset.id,
					),
					signal: abort.signal,
				});
			const { plan, missingColor } = await orderPodcastTimeline({
				audio: selectedAudio.map((item) => ({
					...item,
					asset: sources.get(item.asset.id)!,
				})),
				videos: selectedVideos.map((item) => ({
					...item,
					asset: sources.get(item.asset.id)!,
				})),
				name: name.trim() || localizeClientMessage("Ordered podcast"),
				onProgress: setProgress,
				signal: abort.signal,
			});
			abort.signal.throwIfAborted();
			if (editor.project.getActiveOrNull()?.metadata.id !== projectId)
				throw new Error("The active project changed during synchronization.");
			editor.command.createMulticam({ plan, recoveredDurations: durations });
			setCreated(true);
			await editor.media.persistRecoveredMediaDurations({
				projectId,
				durations,
			});
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
				<div
					dir="ltr"
					className="grid items-start gap-4 md:grid-cols-[minmax(13rem,0.8fr)_minmax(0,1.65fr)]"
				>
					<section
						dir={interfaceDirection(locale)}
						aria-label={t("Assets")}
						className="min-w-0 rounded-xl border bg-muted/20 p-3"
					>
						<h3 className="font-medium">
							<UiMessage text="Assets" />
						</h3>
						<p className="mb-3 mt-1 text-xs text-muted-foreground">
							<UiMessage text="Drag a file to a panel, or select it and use the Add button." />
						</p>
						{sourceAssets.length === 0 && (
							<p className="text-sm text-muted-foreground">
								<UiMessage text="Import video or audio files into Assets first." />
							</p>
						)}
						<ul className="max-h-72 space-y-2 overflow-auto md:max-h-[29rem]">
							{sourceAssets.map((asset) => {
								const Icon = asset.type === "audio" ? AudioLines : Film;
								const angle = assignments[asset.id];
								const inAudio = recordings.some((item) => item.id === asset.id);
								return (
									<li key={asset.id}>
										<button
											type="button"
											data-order-asset={asset.id}
											{...dragProps(asset.id)}
											disabled={asset.missing}
											aria-pressed={selected === asset.id}
											onClick={() =>
												setSelected(selected === asset.id ? null : asset.id)
											}
											className={cn(
												tileClass,
												"cursor-grab hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50",
												selected === asset.id && "border-primary bg-primary/10",
											)}
										>
											<GripVertical
												aria-hidden
												className="size-4 shrink-0 text-muted-foreground"
											/>
											<Icon
												aria-hidden
												className="size-4 shrink-0 text-primary"
											/>
											<span className="min-w-0">
												<span
													dir="auto"
													className="block truncate text-sm"
													title={asset.name}
												>
													{asset.name}
												</span>
												{(asset.missing || angle || inAudio) && (
													<span className="block truncate text-xs text-muted-foreground">
														{asset.missing ? (
															<UiMessage text="Offline" />
														) : angle ? (
															angleLabel(angle)
														) : (
															<UiMessage text="Master audio" />
														)}
													</span>
												)}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					</section>

					<div dir={interfaceDirection(locale)} className="min-w-0 space-y-4">
						<section
							aria-label={t("Master audio recordings")}
							{...dropProps("audio")}
							className="min-w-0 rounded-xl border bg-muted/20 p-3"
						>
							<div className="mb-2 flex items-center justify-between gap-2">
								<h3 className="flex items-center gap-2 font-medium">
									<AudioLines aria-hidden className="size-4 text-primary" />
									<UiMessage text="Master audio recordings" />
								</h3>
								{selected && canPlace(selected, "audio") && (
									<Button
										size="sm"
										variant="outline"
										onClick={() => placeAsset(selected, "audio")}
									>
										<Plus />
										<UiMessage text="Add to audio" />
									</Button>
								)}
							</div>
							<p className="mb-3 text-xs text-muted-foreground">
								<UiMessage text="Drag recordings into the order they were made." />
							</p>
							<ol className="space-y-2">
								{recordings.map(({ id, gap }, index) => (
									<li
										key={id}
										data-order-recording={id}
										{...dropProps("audio", id)}
										className={cn(
											"space-y-2 rounded-md border bg-background p-2",
											dropTarget === `audio-${id}` &&
												"border-t-2 border-t-primary bg-primary/10",
										)}
									>
										<div className="flex items-center gap-1.5">
											<span
												{...dragProps(id)}
												data-order-recording-drag={id}
												className="flex min-w-0 flex-1 cursor-grab items-center gap-2"
												title={sourceById.get(id)?.name}
											>
												<GripVertical
													aria-hidden
													className="size-4 shrink-0 text-muted-foreground"
												/>
												<span className="text-xs tabular-nums text-muted-foreground">
													{index + 1}.
												</span>
												<span dir="auto" className="truncate text-sm">
													{sourceById.get(id)?.name ?? id}
												</span>
											</span>
											<Button
												size="icon"
												variant="ghost"
												disabled={index === 0}
												aria-label={t("Move audio earlier")}
												onClick={() => moveRecording(index, -1)}
											>
												<ArrowUp />
											</Button>
											<Button
												size="icon"
												variant="ghost"
												disabled={index === recordings.length - 1}
												aria-label={t("Move audio later")}
												onClick={() => moveRecording(index, 1)}
											>
												<ArrowDown />
											</Button>
											<Button
												size="icon"
												variant="ghost"
												aria-label={t("Remove {v0}", {
													v0: sourceById.get(id)?.name ?? id,
												})}
												onClick={() =>
													setRecordings((current) =>
														keepGapsForUnchangedNeighbors(
															current,
															current.filter((item) => item.id !== id),
														),
													)
												}
											>
												<X />
											</Button>
										</div>
										{index > 0 && (
											<label className="flex flex-wrap items-center gap-2 ps-2 text-xs text-muted-foreground">
												<UiMessage text="Minimum gap before this file (seconds)" />
												<Input
													className="h-7 w-24"
													type="number"
													min="0"
													max="36000"
													step="any"
													value={gap}
													placeholder={t("Auto")}
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
							<div
								data-order-drop="audio"
								{...dropProps("audio")}
								className={cn(
									dropAreaClass,
									"text-center text-xs text-muted-foreground",
									recordings.length > 0 && "mt-2",
									canPlace(dragging, "audio") && "border-primary/60",
									dropTarget === "audio" && "border-primary bg-primary/10",
								)}
							>
								<UiMessage text="Drop audio here" />
							</div>
						</section>

						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							{Array.from({ length: angleCount }, (_, index) => {
								const angle = index + 1;
								const clips = selectedVideos.filter(
									(item) => item.angle === angle,
								);
								return (
									<section
										key={angle}
										aria-label={angleLabel(angle)}
										data-order-drop={angle}
										{...dropProps(angle)}
										className={cn(
											dropAreaClass,
											"min-w-0",
											canPlace(dragging, angle) && "border-primary/60",
											dropTarget === String(angle) &&
												"border-primary bg-primary/10",
										)}
									>
										<div className="flex flex-wrap items-center justify-between gap-2">
											<h3 className="flex items-center gap-2 font-medium">
												<Film aria-hidden className="size-4 text-primary" />
												{angleLabel(angle)}
											</h3>
											{selected && canPlace(selected, angle) && (
												<Button
													size="sm"
													variant="outline"
													aria-label={t("Add to {v0}", {
														v0: angleLabel(angle),
													})}
													onClick={() => placeAsset(selected, angle)}
												>
													<Plus />
													<UiMessage text="Add" />
												</Button>
											)}
										</div>
										{clips.length === 0 ? (
											<p className="py-4 text-center text-xs text-muted-foreground">
												<UiMessage text="Drop video clips here" />
											</p>
										) : (
											<ul className="mt-2 space-y-2">
												{clips.map(({ asset }) => (
													<li key={asset.id} className={tileClass}>
														<span
															{...dragProps(asset.id)}
															data-order-assigned={asset.id}
															className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5"
														>
															<GripVertical
																aria-hidden
																className="size-4 shrink-0 text-muted-foreground"
															/>
															<span
																dir="auto"
																className="truncate text-sm"
																title={asset.name}
															>
																{asset.name}
															</span>
														</span>
														<Button
															size="icon"
															variant="ghost"
															aria-label={t("Remove {v0}", { v0: asset.name })}
															onClick={() => removeVideo(asset.id)}
														>
															<X />
														</Button>
													</li>
												))}
											</ul>
										)}
									</section>
								);
							})}
						</div>
					</div>
				</div>
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
