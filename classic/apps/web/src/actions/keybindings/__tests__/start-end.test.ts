import { expect, test } from "bun:test";
import { getDefaultShortcuts } from "@/actions/definitions";
import { v8ToV9 } from "../migrations/v8-to-v9";
test("Start End migrates S/E and preserves custom bindings", () => {
	expect(
		v8ToV9({ state: { keybindings: { s: "split" }, isCustomized: false } }),
	).toEqual({
		keybindings: { s: "trim-start", e: "trim-end", "shift+s": "split" },
		isCustomized: false,
	});
	expect(
		v8ToV9({
			state: {
				keybindings: { s: "undo", e: "redo", "shift+s": "copy-selected" },
				isCustomized: true,
			},
		}),
	).toEqual({
		keybindings: { s: "undo", e: "redo", "shift+s": "copy-selected" },
		isCustomized: true,
	});
});

test("default Start End shortcuts do not conflict with split", () => {
	const bindings = getDefaultShortcuts();
	expect(bindings.get("s")).toBe("trim-start");
	expect(bindings.get("e")).toBe("trim-end");
	expect(bindings.get("shift+s")).toBe("split");
});
