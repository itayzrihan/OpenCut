import { getPersistedKeybindingsState } from "../persisted-state";

export function v8ToV9({ state }: { state: unknown }): unknown {
	const previous = getPersistedKeybindingsState({ state });
	if (!previous) return state;
	const keybindings = { ...previous.keybindings };
	if (!keybindings.s || keybindings.s === "split") {
		keybindings.s = "trim-start";
		if (!keybindings["shift+s"]) keybindings["shift+s"] = "split";
	}
	if (!keybindings.e) keybindings.e = "trim-end";
	return { ...previous, keybindings };
}
