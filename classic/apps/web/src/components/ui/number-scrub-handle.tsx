"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { MoveHorizontal } from "lucide-react";

/** Pointer geometry only. Values and history remain owned by the caller. */
export function NumberScrubHandle({
	label,
	disabled,
	value,
	calculate,
	onPreview,
	onCommit,
	onCancel,
}: {
	label: string;
	disabled?: boolean;
	value: number;
	calculate: (args: { start: number; pixels: number }) => number;
	onPreview: (value: number) => void;
	onCommit?: () => void;
	onCancel?: () => void;
}) {
	const current = useRef({ calculate, onPreview, onCommit, onCancel });
	useLayoutEffect(() => {
		current.current = { calculate, onPreview, onCommit, onCancel };
	}, [calculate, onPreview, onCommit, onCancel]);
	const drag = useRef<{
		id: number;
		x: number;
		pixels: number;
		start: number;
		changed: boolean;
	} | null>(null);
	const frame = useRef<number | null>(null);
	const flush = () => {
		if (frame.current !== null) cancelAnimationFrame(frame.current);
		frame.current = null;
		const d = drag.current;
		if (d?.changed)
			current.current.onPreview(
				current.current.calculate({ start: d.start, pixels: d.pixels }),
			);
	};
	const cancel = () => {
		if (frame.current !== null) cancelAnimationFrame(frame.current);
		frame.current = null;
		const d = drag.current;
		drag.current = null;
		if (!d?.changed) return;
		if (current.current.onCancel) current.current.onCancel();
		else {
			current.current.onPreview(d.start);
			current.current.onCommit?.();
		}
	};
	useEffect(
		() => () => {
			if (frame.current !== null) cancelAnimationFrame(frame.current);
			if (drag.current?.changed) current.current.onCancel?.();
		},
		[],
	);
	return (
		<button
			type="button"
			aria-label={`Drag to adjust ${label}`}
			title={`Drag left or right to adjust ${label}. Shift: fine adjustment. Escape: cancel.`}
			disabled={disabled}
			className="flex h-full w-6 shrink-0 touch-none select-none items-center justify-center rounded-l-md border-r border-border text-muted-foreground cursor-ew-resize hover:bg-primary/15 hover:text-primary focus-visible:outline focus-visible:outline-primary"
			onPointerDown={(event) => {
				if (disabled || event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				event.currentTarget.focus();
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = {
					id: event.pointerId,
					x: event.clientX,
					pixels: 0,
					start: value,
					changed: false,
				};
			}}
			onPointerMove={(event) => {
				const d = drag.current;
				if (!d || d.id !== event.pointerId) return;
				const delta = event.clientX - d.x;
				d.x = event.clientX;
				if (!delta) return;
				d.pixels += delta * (event.shiftKey ? 0.1 : 1);
				d.changed = true;
				if (frame.current === null)
					frame.current = requestAnimationFrame(flush);
			}}
			onPointerUp={(event) => {
				const d = drag.current;
				if (!d || d.id !== event.pointerId) return;
				flush();
				drag.current = null;
				event.currentTarget.releasePointerCapture(event.pointerId);
				if (d.changed) current.current.onCommit?.();
			}}
			onPointerCancel={cancel}
			onLostPointerCapture={cancel}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					cancel();
				}
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				event.preventDefault();
				event.stopPropagation();
				current.current.onPreview(
					current.current.calculate({
						start: value,
						pixels: event.key === "ArrowLeft" ? -1 : 1,
					}),
				);
				current.current.onCommit?.();
			}}
		>
			<MoveHorizontal className="size-3.5" aria-hidden="true" />
		</button>
	);
}
