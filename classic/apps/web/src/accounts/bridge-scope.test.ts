import { test, expect } from "bun:test";
import { scopedBridgeSession, accountBridgeCommand } from "./bridge-scope";
test("identical browser session IDs remain isolated across accounts", () => {
	expect(scopedBridgeSession("alice", "same-session")).not.toBe(
		scopedBridgeSession("bob", "same-session"),
	);
	expect(
		accountBridgeCommand("alice", {
			sessionId: "alice_same-session",
			id: "command-1",
		}),
	).toEqual({ sessionId: "same-session", id: "command-1" });
	expect(() =>
		accountBridgeCommand("bob", { sessionId: "alice_same-session" }),
	).toThrow("another account");
	for (const input of ["../alice", "a/b", "", null])
		expect(() => scopedBridgeSession("alice", input)).toThrow();
});
