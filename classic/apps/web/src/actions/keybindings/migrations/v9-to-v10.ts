import { getPersistedKeybindingsState } from "../persisted-state";

export function v9ToV10({ state }: { state: unknown }): unknown {
	const previous = getPersistedKeybindingsState({ state });
	if (!previous) return state;
	const keybindings = { ...previous.keybindings };
	for (const [key, legacyAction, action] of [
		["j", "seek-backward", "playback-slower"],
		["k", "toggle-play", "playback-normal-speed"],
		["l", "seek-forward", "playback-faster"],
	]) {
		const current = keybindings[key];
		if (current === legacyAction || (!current && !previous.isCustomized))
			keybindings[key] = action;
	}
	return { ...previous, keybindings };
}
