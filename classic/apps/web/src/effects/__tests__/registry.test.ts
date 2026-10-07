// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { EffectsRegistry } from "../registry";
import type { EffectDefinition } from "../types";

test("renderer catalog replacement rolls back notified hosts and releases subscriptions", () => {
	const registry = new EffectsRegistry();
	const definition: EffectDefinition = {
		type: "test",
		name: "Original",
		keywords: [],
		params: [],
		renderer: { passes: [] },
	};
	registry.register({ key: "test", definition });
	let observed = registry.catalog();
	const unsubscribe = registry.subscribe((value) => {
		observed = value;
	});
	const reject = registry.subscribe((value) => {
		if (value.some((d) => d.name === "Rejected"))
			throw new Error("Host rejects metadata");
	});
	expect(() =>
		registry.register({
			key: "test",
			definition: { ...definition, name: "Rejected" },
		}),
	).toThrow("Host rejects");
	expect(registry.get("test").name).toBe("Original");
	expect(observed).toEqual(registry.catalog());
	expect(observed[0]).not.toHaveProperty("renderer");
	reject();
	registry.register({
		key: "test",
		definition: { ...definition, name: "Accepted" },
	});
	expect(observed[0].name).toBe("Accepted");
	unsubscribe();
	registry.register({
		key: "test",
		definition: { ...definition, name: "After disposal" },
	});
	expect(observed[0].name).toBe("Accepted");
});
