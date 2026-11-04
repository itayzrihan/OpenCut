import { test, expect } from "bun:test";
import { requestBytes } from "./request";
test("body bounds include missing/lying length and preserve exact bytes", async () => {
	const request = new Request("http://localhost/test", {
		method: "POST",
		body: "exact-original",
	});
	expect(
		new TextDecoder().decode(await requestBytes({ request, limit: 100 })),
	).toBe("exact-original");
	await expect(
		requestBytes({
			request: new Request("http://localhost/test", {
				method: "POST",
				body: "123456789",
			}),
			limit: 3,
		}),
	).rejects.toThrow("size limit");
});
