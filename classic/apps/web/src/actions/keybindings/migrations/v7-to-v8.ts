import { getPersistedKeybindingsState } from "../persisted-state";

export function v7ToV8({ state }: { state: unknown }): unknown {
	const v7 = getPersistedKeybindingsState({ state });
	if (!v7) return state;
	const keybindings = { ...v7.keybindings };

	const hasShortcut = Object.hasOwn(keybindings, "a+t");
	const hasAction = Object.values(keybindings).includes("select-all-text");
	if (!hasShortcut && !hasAction) {
		keybindings["a+t"] = "select-all-text";
	}

	return { ...v7, keybindings };
}
