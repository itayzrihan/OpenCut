import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { CanonicalButton } from "@/components/editor/canonical-button";
import type { CanonicalControlAction } from "@/core/canonical-control";
export { performHostEffect } from "../host-effects";
export { bindCanonicalControl } from "@/core/canonical-control";

let root: Root | null = null;
export function renderControl({
	action,
	disabled = false,
}: {
	action: CanonicalControlAction;
	disabled?: boolean;
}) {
	root ??= createRoot(document.getElementById("controls")!);
	flushSync(() =>
		root!.render(
			<CanonicalButton
				action={action}
				disabled={disabled}
				aria-label="Mute video track"
				aria-pressed={false}
			>
				Mute
			</CanonicalButton>,
		),
	);
}
export function unmountControl() {
	flushSync(() => root?.unmount());
	root = null;
}
