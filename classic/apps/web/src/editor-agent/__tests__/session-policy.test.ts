import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runSessionPolicy } from "../server/session-policy";
const binary = resolve(
	process.cwd(),
	"../../../target/release/opencut-session-policy",
);
test.skipIf(!existsSync(binary))(
	"native policy preserves account fences and allows HTTP timers during validation",
	async () => {
		const previous = process.env.OPENCUT_SESSION_POLICY_BINARY;
		process.env.OPENCUT_SESSION_POLICY_BINARY = binary;
		try {
			let ticks = 0;
			const timer = setInterval(() => ticks++, 1);
			const first = (await runSessionPolicy({
				record: "",
				accountId: "alice",
				projectId: "project",
				request: { type: "read" },
				nowMs: 1000,
			})) as { record: string; result: { saved: null } };
			clearInterval(timer);
			expect(ticks).toBeGreaterThan(0);
			expect(first.result.saved).toBeNull();
			await expect(
				runSessionPolicy({
					record: first.record,
					accountId: "bob",
					projectId: "project",
					request: { type: "read" },
					nowMs: 1001,
				}),
			).rejects.toThrow("another account");
		} finally {
			if (previous === undefined)
				delete process.env.OPENCUT_SESSION_POLICY_BINARY;
			else process.env.OPENCUT_SESSION_POLICY_BINARY = previous;
		}
	},
);
