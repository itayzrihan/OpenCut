import { useEffect, useRef } from "react";
import { invokeAction } from "@/actions";
import { useEditor } from "@/editor/use-editor";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { isTypableDOMElement } from "@/utils/browser";
import type { Key, ShortcutKey } from "@/actions/keybinding";
import { isKey } from "@/actions/keybinding";

/**
 * a composable that hooks to the caller component's
 * lifecycle and hooks to the keyboard events to fire
 * the appropriate actions based on keybindings
 */
export function useKeybindingsListener() {
	const editor = useEditor();
	const pressedKeysRef = useRef<Set<Key>>(new Set());
	const {
		keybindings,
		getKeybindingString,
		overlayDepth,
		isLoadingProject,
		isRecording,
	} = useKeybindingsStore();

	useEffect(() => {
		const eventOptions: AddEventListenerOptions = { capture: true };
		const handleKeyDown = (ev: KeyboardEvent) => {
			const normalizedKey = (ev.key ?? "").toLowerCase();

			if (overlayDepth > 0 || isLoadingProject || isRecording) {
				return;
			}

			const binding = getKeybindingString(ev);
			const activeElement = document.activeElement;
			const isTextInput =
				activeElement instanceof HTMLElement &&
				isTypableDOMElement({ element: activeElement });
			const chordBinding = binding
				? getActiveChordBinding({
						binding,
						keybindings,
						pressedKeys: pressedKeysRef.current,
					})
				: null;
			const effectiveBinding = chordBinding ?? binding;
			const boundAction = effectiveBinding
				? keybindings.get(effectiveBinding)
				: undefined;
			rememberPressedKey({ binding, pressedKeys: pressedKeysRef.current });

			if (normalizedKey === "escape" && isTextInput) {
				activeElement.blur();
				return;
			}

			if (!effectiveBinding) return;
			if (!boundAction) return;

			if (isTextInput) return;
			if (boundAction === "paste-copied") {
				if (!editor.clipboard.hasEntry()) return;
				ev.preventDefault();
				invokeAction("paste-copied", undefined, "keypress");
				return;
			}

			ev.preventDefault();

			switch (boundAction) {
				case "seek-forward":
					invokeAction("seek-forward", { seconds: 1 }, "keypress");
					break;
				case "seek-backward":
					invokeAction("seek-backward", { seconds: 1 }, "keypress");
					break;
				case "jump-forward":
					invokeAction("jump-forward", { seconds: 5 }, "keypress");
					break;
				case "jump-backward":
					invokeAction("jump-backward", { seconds: 5 }, "keypress");
					break;
				default:
					invokeAction(boundAction, undefined, "keypress");
			}
		};
		const handleKeyUp = (ev: KeyboardEvent) => {
			const binding = getKeybindingString(ev);
			if (!binding) return;
			forgetPressedKey({ binding, pressedKeys: pressedKeysRef.current });
		};
		const clearPressedKeys = () => {
			pressedKeysRef.current.clear();
		};

		document.addEventListener("keydown", handleKeyDown, eventOptions);
		document.addEventListener("keyup", handleKeyUp, eventOptions);
		window.addEventListener("blur", clearPressedKeys);

		return () => {
			document.removeEventListener("keydown", handleKeyDown, eventOptions);
			document.removeEventListener("keyup", handleKeyUp, eventOptions);
			window.removeEventListener("blur", clearPressedKeys);
			clearPressedKeys();
		};
	}, [
		keybindings,
		getKeybindingString,
		overlayDepth,
		isLoadingProject,
		isRecording,
		editor,
	]);
}

function getActiveChordBinding({
	binding,
	keybindings,
	pressedKeys,
}: {
	binding: ShortcutKey;
	keybindings: Map<ShortcutKey, unknown>;
	pressedKeys: Set<Key>;
}): ShortcutKey | null {
	if (!isKey(binding)) return null;

	for (const pressedKey of pressedKeys) {
		if (pressedKey === binding) continue;
		const forward = `${pressedKey}+${binding}` as ShortcutKey;
		if (keybindings.has(forward)) return forward;
		const reverse = `${binding}+${pressedKey}` as ShortcutKey;
		if (keybindings.has(reverse)) return reverse;
	}
	return null;
}

function rememberPressedKey({
	binding,
	pressedKeys,
}: {
	binding: ShortcutKey | null;
	pressedKeys: Set<Key>;
}) {
	if (binding && isKey(binding)) {
		pressedKeys.add(binding);
	}
}

function forgetPressedKey({
	binding,
	pressedKeys,
}: {
	binding: ShortcutKey | null;
	pressedKeys: Set<Key>;
}) {
	if (binding && isKey(binding)) {
		pressedKeys.delete(binding);
	}
}
