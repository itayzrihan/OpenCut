import { expect, test } from "bun:test";
import { GET } from "@/app/api/accounts/legitate/callback/route";

test("expired Legitate callbacks offer a fresh local sign-in without reflecting credentials", async () => {
	const response = await GET(
		new Request(
			"http://127.0.0.1:3000/api/accounts/legitate/callback?state=old-private-state&code=old-private-code",
		),
	);
	expect(response.status).toBe(400);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(response.headers.get("content-type")).toContain("text/html");
	const body = await response.text();
	expect(body).toContain("This sign-in link expired");
	expect(body).toContain('href="/projects?tab=account"');
	expect(body).not.toContain("old-private-code");
	expect(body).not.toContain("old-private-state");
});
