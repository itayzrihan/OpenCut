"use client";
import { useEffect, useRef, useState } from "react";
import {
	motion,
	useMotionValue,
	useSpring,
	useTransform,
	useReducedMotion,
	AnimatePresence,
} from "motion/react";
import {
	Check,
	ChevronUp,
	X,
	Loader2,
	AlertCircle,
	Square,
} from "lucide-react";
import { batchEditIsLocked, fullAutoEditStages } from "opencut-wasm";
import type { BatchState, SingleEditProgress } from "./types";
const stageNames: Record<string, string> = {
	preflight: "Check source, font & model",
	framing: "Vertical frame · face & body",
	silence: "Remove silences · 0.3s",
	"auto-texts": "Hebrew Auto Texts · correct & arrange",
	finish: "Caption style & edge feather",
	zoom: "Automatic Zoom",
	transitions: "Automatic Transitions",
	"word-animation": "Word Animation & Reveal",
	music: "Automatic Music",
	save: "Save for review",
};
const clamp = ({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}) => Math.max(min, Math.min(Math.max(min, max), value));
export function AutomationProgress({
	state,
	single,
	onOpenBatch,
	onClearSingle,
}: {
	state: BatchState;
	single: SingleEditProgress | null;
	onOpenBatch: () => void;
	onClearSingle: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [openedAt] = useState(() => Date.now());
	const [dismissed, setDismissed] = useState("");
	const [viewport, setViewport] = useState({ width: 1000, height: 800 });
	const x = useMotionValue(0),
		y = useMotionValue(0);
	const reduced = useReducedMotion();
	const width = Math.min(352, viewport.width - 24);
	const panelTargetX = useTransform(x, (v) =>
		clamp({
			value: v + 232 - width,
			min: 12,
			max: viewport.width - width - 12,
		}),
	);
	const panelTargetY = useTransform(y, (v) =>
		clamp({
			value: v >= 370 ? v - 360 : v + 80,
			min: 12,
			max: viewport.height - 370,
		}),
	);
	const followX = useSpring(panelTargetX, {
		stiffness: 210,
		damping: 24,
		mass: 0.8,
	});
	const followY = useSpring(panelTargetY, {
		stiffness: 190,
		damping: 23,
		mass: 0.8,
	});
	const drag = useRef<{
		sx: number;
		sy: number;
		px: number;
		py: number;
		moved: boolean;
	} | null>(null);
	const suppressClick = useRef(false);
	useEffect(() => {
		const resize = () => {
			setViewport({ width: innerWidth, height: innerHeight });
			x.set(
				clamp({
					value: x.get() || innerWidth - 256,
					min: 12,
					max: innerWidth - 244,
				}),
			);
			y.set(
				clamp({
					value: y.get() || innerHeight - 108,
					min: 12,
					max: innerHeight - 84,
				}),
			);
		};
		resize();
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, [x, y]);
	const run =
		state.runs.find((r) =>
			r.jobs.some((j) => batchEditIsLocked({ status: j.status })),
		) ?? state.runs[0];
	const useSingle =
		single?.status === "running" ||
		(!!single &&
			!run?.jobs.some((j) => batchEditIsLocked({ status: j.status })) &&
			(!run || single.updatedAt > run.updatedAt));
	const key = useSingle ? `single-${single!.id}` : run?.id;
	const visible =
		!!key &&
		key !== dismissed &&
		(useSingle ||
			(!!run &&
				(openedAt - run.updatedAt < 600000 ||
					run.jobs.some((j) => batchEditIsLocked({ status: j.status })))));
	const job =
		run?.jobs.find((j) => j.status === "running" || j.status === "importing") ??
		run?.jobs.find((j) => batchEditIsLocked({ status: j.status })) ??
		run?.jobs.at(-1);
	const stages = fullAutoEditStages(
		useSingle
			? single!.options
			: (run?.options ?? {
					zoom: false,
					transitions: false,
					wordAnimation: false,
					music: false,
				}),
	);
	const completed = useSingle
		? single!.completedStages
		: (job?.completedStages ?? 0);
	const totalVideos = useSingle ? 1 : (run?.jobs.length ?? 1);
	const ready = useSingle
		? single!.status === "completed"
			? 1
			: 0
		: (run?.jobs.filter((j) => j.status === "completed").length ?? 0);
	const stopped = useSingle
		? single!.status !== "running"
			? 1
			: 0
		: (run?.jobs.filter((j) => !batchEditIsLocked({ status: j.status }))
				.length ?? 0);
	const active = useSingle
		? single!.status === "running"
		: !!run?.jobs.some((j) => batchEditIsLocked({ status: j.status }));
	const message = useSingle ? single!.message : (job?.message ?? "Preparing…");
	const error = useSingle
		? ["failed", "cancelled"].includes(single!.status)
		: !!run?.jobs.some((j) =>
				["failed", "cancelled", "interrupted"].includes(j.status),
			);
	const stageWork = useSingle
		? completed
		: (run?.jobs.reduce((sum, j) => sum + (j.completedStages ?? 0), 0) ?? 0);
	const percent = Math.round((100 * stageWork) / (stages.length * totalVideos));
	if (!visible) return null;
	return (
		<div
			className="pointer-events-none fixed inset-0 z-[240]"
			aria-label="Automation activity"
		>
			<AnimatePresence>
				{expanded && (
					<motion.section
						key="details"
						aria-label="Automation progress details"
						className="pointer-events-auto fixed left-0 top-0 rounded-2xl border border-border/80 bg-background/95 backdrop-blur-xl shadow-2xl overflow-hidden"
						style={{
							x: reduced ? panelTargetX : followX,
							y: reduced ? panelTargetY : followY,
							width,
							maxHeight: 348,
						}}
						initial={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
						animate={{ opacity: 1, scale: 1 }}
						exit={{ opacity: 0, scale: reduced ? 1 : 0.97 }}
						transition={{ duration: 0.15 }}
						onKeyDown={(e) => {
							if (e.key === "Escape") setExpanded(false);
						}}
					>
						<header className="p-4 pb-2 flex items-start justify-between gap-3">
							<div>
								<h2 className="text-sm font-semibold">
									{useSingle ? "Full Auto Edit" : "Batch · Full Auto Edit"}
								</h2>
								<p className="text-xs text-muted-foreground mt-1">
									{ready}/{totalVideos} videos ready
									{stopped > ready
										? ` · ${stopped - ready} stopped`
										: ""} · {completed}/{stages.length} stages in this video
								</p>
							</div>
							<button
								aria-label="Collapse automation details"
								className="p-1 rounded hover:bg-accent"
								onClick={() => setExpanded(false)}
							>
								<X size={16} />
							</button>
						</header>
						<div className="px-4 pb-3 space-y-2 max-h-56 overflow-y-auto">
							<p className="text-xs font-medium truncate">
								{useSingle ? single!.name : job?.fileName}
							</p>
							<p
								role="status"
								className="text-xs text-muted-foreground leading-relaxed"
							>
								{message}
							</p>
							<ol className="space-y-2 pt-1">
								{stages.map((stage, i) => (
									<li
										key={stage}
										className={`flex items-center gap-2 text-xs ${i > completed ? "text-muted-foreground/60" : ""}`}
									>
										{i < completed ? (
											<Check size={13} className="text-emerald-500" />
										) : i === completed &&
										  active &&
										  (useSingle || job?.status === "running") ? (
											<Loader2
												size={13}
												className={reduced ? "" : "animate-spin"}
											/>
										) : (
											<span className="w-[13px] text-center">·</span>
										)}
										<span>{stageNames[stage] ?? stage}</span>
										{i === completed &&
											active &&
											(useSingle || job?.status === "running") && (
												<span className="ml-auto text-[10px] text-primary">
													Working
												</span>
											)}
									</li>
								))}
							</ol>
						</div>
						<footer className="border-t px-4 py-2 flex justify-between gap-3 text-xs">
							{useSingle ? (
								active ? (
									<button
										className="flex items-center gap-1"
										onClick={single!.cancel}
									>
										<Square size={10} />
										Cancel editing
									</button>
								) : (
									<button
										onClick={() => {
											setDismissed(key!);
											onClearSingle();
										}}
									>
										Dismiss
									</button>
								)
							) : (
								<button className="underline" onClick={onOpenBatch}>
									All videos & controls
								</button>
							)}
							<span className="text-muted-foreground">
								{percent}% of stages complete
							</span>
							{!active && !useSingle && (
								<button onClick={() => setDismissed(key!)}>Dismiss</button>
							)}
						</footer>
					</motion.section>
				)}
			</AnimatePresence>
			<motion.button
				type="button"
				aria-label="Automation progress · drag to move, click for details"
				aria-expanded={expanded}
				aria-describedby="automation-drag-help"
				className="pointer-events-auto fixed left-0 top-0 flex items-center gap-2 rounded-full bg-background/95 backdrop-blur-xl border border-border/80 shadow-xl pr-4 p-1.5 text-left select-none touch-none cursor-grab active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-primary"
				style={{ x, y, width: 232, height: 68 }}
				onPointerDown={(e) => {
					e.currentTarget.setPointerCapture(e.pointerId);
					suppressClick.current = false;
					drag.current = {
						sx: e.clientX,
						sy: e.clientY,
						px: x.get(),
						py: y.get(),
						moved: false,
					};
				}}
				onPointerMove={(e) => {
					const d = drag.current;
					if (!d) return;
					const dx = e.clientX - d.sx,
						dy = e.clientY - d.sy;
					d.moved ||= Math.hypot(dx, dy) > 5;
					if (d.moved) {
						x.set(
							clamp({ value: d.px + dx, min: 12, max: viewport.width - 244 }),
						);
						y.set(
							clamp({ value: d.py + dy, min: 12, max: viewport.height - 80 }),
						);
					}
				}}
				onPointerUp={() => {
					suppressClick.current = drag.current?.moved ?? false;
					drag.current = null;
				}}
				onPointerCancel={() => {
					drag.current = null;
					suppressClick.current = true;
				}}
				onClick={() => {
					if (suppressClick.current) {
						suppressClick.current = false;
						return;
					}
					setExpanded((v) => !v);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						e.stopPropagation();
						setExpanded((v) => !v);
						return;
					}
					const amount = e.shiftKey ? 32 : 12;
					if (
						["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
					) {
						e.preventDefault();
						e.stopPropagation();
						x.set(
							clamp({
								value:
									x.get() +
									(e.key === "ArrowRight"
										? amount
										: e.key === "ArrowLeft"
											? -amount
											: 0),
								min: 12,
								max: viewport.width - 244,
							}),
						);
						y.set(
							clamp({
								value:
									y.get() +
									(e.key === "ArrowDown"
										? amount
										: e.key === "ArrowUp"
											? -amount
											: 0),
								min: 12,
								max: viewport.height - 80,
							}),
						);
					}
				}}
			>
				<span className="relative size-[54px] shrink-0">
					<svg
						viewBox="0 0 60 60"
						className="absolute inset-0 size-full -rotate-90"
						aria-hidden
					>
						<circle
							cx="30"
							cy="30"
							r="25"
							fill="none"
							stroke="currentColor"
							strokeWidth="3"
							className="text-muted"
						/>
						<motion.circle
							cx="30"
							cy="30"
							r="25"
							fill="none"
							stroke="currentColor"
							strokeWidth="3"
							strokeLinecap="round"
							strokeDasharray={157.08}
							animate={{ strokeDashoffset: 157.08 * (1 - percent / 100) }}
							transition={{ duration: reduced ? 0 : 0.3 }}
							className={error && !active ? "text-amber-500" : "text-primary"}
						/>
					</svg>
					<span className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums">
						{!active && ready === totalVideos ? (
							<Check size={20} />
						) : error && !active ? (
							<AlertCircle size={19} />
						) : (
							`${percent}%`
						)}
					</span>
					{active && (
						<motion.span
							className="absolute inset-0"
							animate={{ rotate: reduced ? 0 : 360 }}
							transition={{ duration: 2.8, repeat: Infinity, ease: "linear" }}
						>
							<span className="absolute left-1/2 top-0 size-1.5 -translate-x-1/2 rounded-full bg-primary" />
						</motion.span>
					)}
				</span>
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-1 text-xs font-semibold">
						{active
							? `${ready}/${totalVideos} ready`
							: error
								? "Needs review"
								: "Ready for review"}
						<ChevronUp size={12} className={expanded ? "rotate-180" : ""} />
					</span>
					<span className="block truncate text-[11px] text-muted-foreground mt-1">
						{active
							? message
							: `${ready} completed · ${stopped - ready} stopped`}
					</span>
				</span>
			</motion.button>
			<span id="automation-drag-help" className="sr-only">
				Drag to reposition. Arrow keys move the control. Enter opens progress
				details.
			</span>
		</div>
	);
}
