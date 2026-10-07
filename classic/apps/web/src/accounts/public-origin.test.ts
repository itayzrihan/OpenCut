import { afterEach, expect, test } from "bun:test";
import { assertLocalOrigin, localRequestOrigin, sessionCookie } from "./server";

const previous = process.env.OPENCUT_PUBLIC_ORIGIN;
afterEach(() => {
	if (previous === undefined) delete process.env.OPENCUT_PUBLIC_ORIGIN;
	else process.env.OPENCUT_PUBLIC_ORIGIN = previous;
});
const origin = "https://example.tailnet.ts.net:8443";
function request({
	host,
	source = origin,
	proto = "https",
}: {
	host: string;
	source?: string;
	proto?: string;
}) {
	return new Request("http://127.0.0.1:3100/api/accounts", {
		method: "POST",
		headers: {
			host,
			origin: source,
			"x-forwarded-proto": proto,
			"sec-fetch-site": "same-origin",
		},
	});
}
test("public storage requires an explicit exact HTTPS origin", () => {
	delete process.env.OPENCUT_PUBLIC_ORIGIN;
	expect(() =>
		localRequestOrigin(request({ host: "example.tailnet.ts.net:8443" })),
	).toThrow();
	process.env.OPENCUT_PUBLIC_ORIGIN = origin;
	expect(
		localRequestOrigin(request({ host: "example.tailnet.ts.net:8443" })),
	).toBe(origin);
	expect(() =>
		assertLocalOrigin(request({ host: "example.tailnet.ts.net:8443" })),
	).not.toThrow();
	expect(() =>
		assertLocalOrigin(
			request({
				host: "example.tailnet.ts.net:8443",
				source: "https://evil.example",
			}),
		),
	).toThrow();
	expect(() => localRequestOrigin(request({ host: "evil.example" }))).toThrow();
	expect(() =>
		localRequestOrigin(
			request({
				host: "example.tailnet.ts.net:8443",
				source: origin,
				proto: "http",
			}),
		),
	).toThrow();
	expect(sessionCookie("sample")).toContain("; Secure");
});
