/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Native HTTP headers are projected into a Request in this isolated browser fixture. */
import { expect, mock, test } from "bun:test";
import { createServer } from "node:http";
import { NextRequest } from "next/server";
import { acquireBrowser } from "@hyperframes/engine";
import { oauthReturnDocument } from "./oauth-return";

const handoff = "12345678-1234-1234-1234-123456789abc";
const session = "a".repeat(64);
let consumed = 0;
mock.module("@/accounts/server", () => ({
	withAccount:
		(handler: (request: NextRequest) => Promise<Response>) =>
		async (request: NextRequest) => {
			if (
				!request.headers.get("cookie")?.includes(`opencut-account=${session}`)
			)
				return Response.json(
					{ error: "Sign in to access this account's data" },
					{ status: 401 },
				);
			const response = await handler(request);
			if (!response.headers.has("Content-Security-Policy")) response.headers.set("Content-Security-Policy", "sandbox");
			return response;
		},
}));
mock.module("@/ai/server/openai-codex-oauth", () => ({
	completeOpenAIAuthorizationHandoff: async ({
		request,
	}: {
		request: NextRequest;
	}) => {
		consumed++;
		return {
			response: Response.redirect(new URL("/done", request.url), 302),
			success: true,
		};
	},
}));

test("OAuth landing carries no credentials and only resumes one bounded cross-site handoff", async () => {
	const url = `http://127.0.0.1:3100/api/ai/oauth/complete?handoff=${handoff}`;
	const response = oauthReturnDocument(
		new Request(url, { headers: { "sec-fetch-site": "cross-site" } }),
	)!;
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toContain("no-store");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(response.headers.get("set-cookie")).toBeNull();
	expect(response.headers.get("content-security-policy")).toContain(
		"frame-ancestors 'none'",
	);
	const html = await response.text();
	expect(html).toContain(`handoff=${handoff}&opencutReturn=1`);
	expect(html).not.toContain(session);
	expect(html).not.toContain("access_token");
	for (const [href, method, site] of [
		[url, "GET", "same-origin"],
		[url, "POST", "cross-site"],
		[url + "&opencutReturn=1", "GET", "cross-site"],
		[url.replace(handoff, "<script>alert(1)</script>"), "GET", "cross-site"],
		[url.replace("/complete", "/other"), "GET", "cross-site"],
	])
		expect(
			oauthReturnDocument(
				new Request(href, { method, headers: { "sec-fetch-site": site } }),
			),
		).toBeNull();
});

test("a return document cannot consume or complete an unauthenticated OAuth handoff", async () => {
	const { GET } = await import("@/app/api/ai/oauth/complete/route");
	consumed = 0;
	const url = `http://127.0.0.1:3100/api/ai/oauth/complete?handoff=${handoff}`;
	expect(
		(
			await GET(
				new NextRequest(url, { headers: { "sec-fetch-site": "cross-site" } }),
			)
		).status,
	).toBe(200);
	expect(consumed).toBe(0);
	expect(
		(
			await GET(
				new NextRequest(url + "&opencutReturn=1", {
					headers: { "sec-fetch-site": "same-origin" },
				}),
			)
		).status,
	).toBe(401);
	expect(consumed).toBe(0);
	expect(
		(
			await GET(
				new NextRequest(url + "&opencutReturn=1", {
					headers: {
						"sec-fetch-site": "same-origin",
						cookie: `opencut-account=${session}`,
					},
				}),
			)
		).status,
	).toBe(302);
	expect(consumed).toBe(1);
});

test("real Chromium restores the Strict cookie after a cross-site OAuth redirect", async () => {
	const { GET } = await import("@/app/api/ai/oauth/complete/route");
	const observations: Array<{ site: string; cookie: boolean; url: string }> =
		[];
	let appOrigin = "";
	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url!, appOrigin);
			if (url.pathname === "/") {
				response
					.writeHead(200, {
						"content-type": "text/html",
						"set-cookie": `opencut-account=${session}; HttpOnly; SameSite=Strict; Path=/`,
					})
					.end('<a href="/depart">Connect provider</a>');
				return;
			}
			if (url.pathname === "/depart") {
				response
					.writeHead(302, {
						location: appOrigin.replace("127.0.0.1", "localhost") + "/provider",
					})
					.end();
				return;
			}
			if (url.pathname === "/provider") {
				response
					.writeHead(200, { "content-type": "text/html" })
					.end(
						`<a href="${appOrigin}/api/ai/oauth/complete?handoff=${handoff}">Return to OpenCut</a>`,
					);
				return;
			}
			if (url.pathname === "/done") {
				response
					.writeHead(200, { "content-type": "text/html" })
					.end("<h1>Connected to OpenCut</h1>");
				return;
			}
			observations.push({
				site: String(request.headers["sec-fetch-site"]),
				cookie:
					request.headers.cookie?.includes(`opencut-account=${session}`) ??
					false,
				url: url.pathname + url.search,
			});
			const result = await GET(
				new NextRequest(url, {
					headers: request.headers as Record<string, string>,
				}),
			);
			response
				.writeHead(result.status, Object.fromEntries(result.headers.entries()))
				.end(await result.text());
		})().catch((error) => {
			response.writeHead(500).end(String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw Error("Missing fixture address");
	appOrigin = `http://127.0.0.1:${address.port}`;
	const lease = await acquireBrowser(["--disable-gpu"], {
		enableBrowserPool: false,
		forceScreenshot: true,
	});
	try {
		const page = await lease.browser.newPage();
		await page.goto(appOrigin);
		await Promise.all([
			page.waitForNavigation({ waitUntil: "networkidle0" }),
			page.click("a"),
		]);
		await Promise.all([
			page.waitForNavigation({ waitUntil: "networkidle0" }),
			page.click("a"),
		]);
		expect(await page.$eval("h1", (node) => node.textContent)).toBe(
			"Connected to OpenCut",
		);
		expect(observations).toEqual([
			{
				site: "cross-site",
				cookie: false,
				url: `/api/ai/oauth/complete?handoff=${handoff}`,
			},
			{
				site: "same-origin",
				cookie: true,
				url: `/api/ai/oauth/complete?handoff=${handoff}&opencutReturn=1`,
			},
		]);
	} finally {
		await lease.release();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}, 60_000);
