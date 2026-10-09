// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { masksRegistry, registerDefaultMasks } from "@/masks";
import { MasksRegistry } from "../registry";

test("mask catalog replacement retains order, rolls back rejected hosts and disposes subscriptions", () => {
	registerDefaultMasks();
	const registry = new MasksRegistry();
	const rectangle = masksRegistry.get("rectangle");
	registry.register({ key: "rectangle", definition: rectangle });
	registry.register({
		key: "ellipse",
		definition: masksRegistry.get("ellipse"),
	});
	let observed = registry.catalog();
	const unsubscribe = registry.subscribe((value) => {
		observed = value;
	});
	const reject = registry.subscribe((value) => {
		if (value.some((definition) => definition.name === "Rejected"))
			throw new Error("Host rejects metadata");
	});
	expect(() =>
		registry.register({
			key: "rectangle",
			definition: { ...rectangle, name: "Rejected" },
		}),
	).toThrow("Host rejects metadata");
	expect(registry.get("rectangle")).toBe(rectangle);
	expect(observed).toEqual(registry.catalog());
	expect(observed[0]).not.toHaveProperty("renderer");
	expect(observed[0]).not.toHaveProperty("interaction");
	reject();
	registry.register({
		key: "rectangle",
		definition: { ...rectangle, name: "Accepted" },
	});
	expect(observed.map((definition) => definition.type)).toEqual([
		"rectangle",
		"ellipse",
	]);
	expect(observed).toEqual(registry.catalog());
	expect(observed[0].name).toBe("Accepted");
	unsubscribe();
	registry.register({
		key: "rectangle",
		definition: { ...rectangle, name: "After disposal" },
	});
	expect(observed[0].name).toBe("Accepted");
	expect(() =>
		registry.register({ key: "ellipse", definition: rectangle }),
	).toThrow("key must match type");
});
