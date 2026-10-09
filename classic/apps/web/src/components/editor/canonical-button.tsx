"use client";
import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import {
	bindCanonicalControl,
	getCanonicalControlAction,
	type CanonicalControlAction,
} from "@/core/canonical-control";

/** Define a feature gesture once: the button executes the same canonical input
 * that semantic observation supplies to agent discovery. No model tool wiring. */
export function CanonicalButton({
	action,
	...props
}: Omit<ButtonProps, "onClick" | "asChild"> & {
	action: CanonicalControlAction;
}) {
	const editor = useEditor();
	const projectId = editor.project.getActiveOrNull()?.metadata.id;
	const accountId =
		typeof window === "undefined"
			? "local"
			: (window.__opencutAccountId ?? "local");
	const cleanup = useRef<(() => void) | null>(null);
	const ref = useCallback(
		(element: HTMLButtonElement | null) => {
			cleanup.current?.();
			cleanup.current =
				element && projectId && !props.disabled
					? bindCanonicalControl({
							element,
							binding: { projectId, accountId, action },
						})
					: null;
		},
		[projectId, accountId, action, props.disabled],
	);
	return (
		<Button
			{...props}
			ref={ref}
			disabled={props.disabled || !projectId}
			onClick={(event) => {
				event.stopPropagation();
				if (!projectId) return;
				try {
					const bound = getCanonicalControlAction({
						element: event.currentTarget,
						accountId,
						projectId,
					});
					if (!bound)
						throw new Error("The control binding is no longer active");
					editor.command.invokeCanonicalControl({
						...bound,
						projectId,
						accountId,
					});
				} catch (error) {
					toast.error(
						error instanceof Error
							? error.message
							: "The edit could not be applied",
					);
				}
			}}
		/>
	);
}
