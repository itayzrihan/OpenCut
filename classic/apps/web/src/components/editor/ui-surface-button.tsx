"use client";
import { useCallback, useRef } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { bindEditorUiSurface } from "@/editor-agent/ui-targets";
/** Presentation-only button: never use for a document edit, account action,
 * external navigation or job launch. CanonicalButton handles document edits. */
export function UiSurfaceButton(props: ButtonProps) {
	const cleanup = useRef<(() => void) | null>(null);
	const ref = useCallback((element: HTMLButtonElement | null) => {
		cleanup.current?.();
		cleanup.current = element
			? bindEditorUiSurface({ element, gestures: ["click"] })
			: null;
	}, []);
	return <Button {...props} ref={ref} />;
}
