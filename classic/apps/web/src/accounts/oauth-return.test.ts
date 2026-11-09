import { expect, test } from "bun:test";
import { GET as start } from "@/app/api/ai/oauth/start/route";
import { GET as callback } from "@/app/api/ai/oauth/callback/route";
import { GET as complete } from "@/app/api/ai/oauth/complete/route";
import { POST as device } from "@/app/api/ai/oauth/device/route";

test("legacy Codex sign-in and pending handoffs are retired", async () => {
	for (const route of [start, callback, complete, device]) {
		const response = route();
		expect(response.status).toBe(410);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(response.headers.get("location")).toBeNull();
		expect(await response.json()).toEqual({
			error:
				"The separate Codex sign-in was retired. Connect ChatGPT in the POCUT Agent.",
		});
	}
});
