import { test, expect } from "bun:test";
import { scopedBridgeSession, accountBridgeCommand } from "./bridge-scope";
test("identical browser session IDs remain isolated across accounts", () => {
	expect(scopedBridgeSession({ accountId: "alice", sessionId: "same-session" })).not.toBe(
		scopedBridgeSession({ accountId: "bob", sessionId: "same-session" }),
	);
	expect(
		accountBridgeCommand({ accountId: "alice", value: {
			sessionId: "alice_same-session",
			id: "command-1",
		} }),
	).toEqual({ sessionId: "same-session", id: "command-1" });
	expect(() =>
		accountBridgeCommand({ accountId: "bob", value: { sessionId: "alice_same-session" } }),
	).toThrow("another account");
	for (const input of ["../alice", "a/b", "", null])
		expect(() => scopedBridgeSession({ accountId: "alice", sessionId: input })).toThrow();
});
