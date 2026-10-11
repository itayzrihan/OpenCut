"use client";
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- WAI-ARIA window splitter: a focusable separator with value and arrow-key controls. */
import { useRef } from "react";

/** Transient pointer geometry only; the final size commits through the editor registry. */
export function TrackControlsResizer({
	width,
	onPreview,
	onCommit,
}: {
	width: number;
	onPreview: (width: number | null) => void;
	onCommit: (width: number) => void;
}) {
	const drag = useRef<{
		pointer: number;
		x: number;
		width: number;
		next: number;
	} | null>(null);
	const bounded = (value: number) =>
		Math.max(80, Math.min(480, Math.round(value)));
	return (
		<div
			role="separator"
			aria-label="Resize track controls"
			aria-orientation="vertical"
			aria-valuemin={80}
			aria-valuemax={480}
			aria-valuenow={width}
			tabIndex={0}
			title="Drag to resize track controls. Arrow keys adjust width; double-click to reset."
			className="absolute inset-y-0 -right-1 z-50 w-2 touch-none cursor-col-resize bg-transparent hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none"
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = {
					pointer: event.pointerId,
					x: event.clientX,
					width,
					next: width,
				};
			}}
			onPointerMove={(event) => {
				const d = drag.current;
				if (!d || d.pointer !== event.pointerId) return;
				d.next = bounded(d.width + event.clientX - d.x);
				onPreview(d.next);
			}}
			onPointerUp={(event) => {
				const d = drag.current;
				if (!d || d.pointer !== event.pointerId) return;
				drag.current = null;
				event.currentTarget.releasePointerCapture(event.pointerId);
				onCommit(d.next);
			}}
			onLostPointerCapture={() => {
				if (drag.current) {
					drag.current = null;
					onPreview(null);
				}
			}}
			onPointerCancel={() => {
				drag.current = null;
				onPreview(null);
			}}
			onDoubleClick={() => onCommit(112)}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					drag.current = null;
					onPreview(null);
					return;
				}
				const next =
					event.key === "ArrowLeft"
						? width - 16
						: event.key === "ArrowRight"
							? width + 16
							: event.key === "Home"
								? 80
								: event.key === "End"
									? 480
									: null;
				if (next !== null) {
					event.preventDefault();
					event.stopPropagation();
					onCommit(bounded(next));
				}
			}}
		/>
	);
}
