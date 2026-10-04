import { expect, spyOn, test } from "bun:test";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { HyperframesCaptureSession } from "../capture-session";
import { HyperframesRenderHost } from "../render-host";
import type { HyperframesSource } from "../types";

const source: HyperframesSource = {
	entryFile: "scene.html",
	resourceAssetIds: {},
	files: {
		"scene.html":
			'<!doctype html><html><body style="margin:0"><div data-composition-id="test" data-no-timeline data-width="64" data-height="64" data-duration="2" style="width:64px;height:64px;background:red"></div></body></html>',
	},
};

function readPreview(url: string): Promise<Response> {
	// Node does not resolve random .localhost labels on every platform.
	const address = new URL(url);
	return fetch(`http://127.0.0.1:${address.port}${address.pathname}`, {
		headers: { Host: address.host },
	});
}

test.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"real host scopes sessions and artifacts to the exact account and project",
	async () => {
		const runtime = await createCanonicalTestRuntime();
		const host = new HyperframesRenderHost(runtime);
		const scope = { accountId: "account-a", projectId: "project-a" };
		const captures: HyperframesCaptureSession[] = [];
		const openCapture = HyperframesCaptureSession.open;
		const captureSpy = spyOn(
			HyperframesCaptureSession,
			"open",
		).mockImplementation(async (options) => {
			const session = await openCapture(options);
			captures.push(session);
			return session;
		});
		try {
			const opened = await host.open({
				scope,
				source,
				resolveResource: async () => null,
			});
			expect(opened.durationSeconds).toBe(2);
			expect(opened.previewUrl).toMatch(
				/^http:\/\/[a-f0-9]{48}\.localhost:\d+\/scene.html$/,
			);
			for (const wrong of [
				{ ...scope, accountId: "account-b" },
				{ ...scope, projectId: "project-b" },
			]) {
				await expect(
					host.capture({ scope: wrong, id: opened.id, timeSeconds: 0 }),
				).rejects.toThrow("unavailable");
				await expect(
					host.closeSession({ scope: wrong, id: opened.id }),
				).rejects.toThrow("unavailable");
				await expect(
					host.keepAlive({ scope: wrong, id: opened.id }),
				).rejects.toThrow("unavailable");
				await expect(
					host.audio({ scope: wrong, id: opened.id }),
				).rejects.toThrow("unavailable");
				await expect(
					host.livePreview({ scope: wrong, id: opened.id }),
				).rejects.toThrow("unavailable");
			}
			const before = await host.capture({
				scope,
				id: opened.id,
				timeSeconds: 0,
			});
			const live = await host.livePreview({ scope, id: opened.id });
			expect(captures).toHaveLength(1);
			expect(captures[0].isClosed).toBe(true);
			expect((await readPreview(opened.previewUrl)).status).toBe(404);
			expect(await host.keepAlive({ scope, id: opened.id })).toBe(true);
			expect(live.url).toMatch(
				/^http:\/\/[a-f0-9]{48}\.localhost:\d+\/\.opencut-live-[a-f0-9]{48}\.html$/,
			);
			expect(await host.livePreview({ scope, id: opened.id })).toEqual(live);
			const liveAddress = new URL(live.url);
			const shell = await readPreview(live.url);
			expect(shell.status).toBe(200);
			expect(shell.headers.get("Content-Security-Policy")).toContain(
				`frame-src ${liveAddress.origin}`,
			);
			expect(shell.headers.get("Permissions-Policy")).toContain("autoplay=()");
			const artifact = await host.capture({
				scope,
				id: opened.id,
				timeSeconds: 0,
			});
			expect(captures).toHaveLength(2);
			expect(captures[1].isClosed).toBe(false);
			expect(artifact.sha256).toBe(before.sha256);
			expect((await readPreview(live.url)).status).toBe(200);
			const output = host.readArtifact({ scope, id: artifact.id });
			const reduced = await host.capture({
				scope,
				id: opened.id,
				timeSeconds: 0,
				previewScale: 0.5,
			});
			expect([reduced.width, reduced.height]).toEqual([32, 32]);
			expect([...output.bytes.slice(0, 8)]).toEqual([
				137, 80, 78, 71, 13, 10, 26, 10,
			]);
			expect(output.artifact.sha256).toBe(artifact.sha256);
			expect(() =>
				host.readArtifact({
					scope: { ...scope, accountId: "account-b" },
					id: artifact.id,
				}),
			).toThrow("unavailable");
			expect(() =>
				host.readArtifact({
					scope: { ...scope, projectId: "project-b" },
					id: artifact.id,
				}),
			).toThrow("unavailable");
			expect(() =>
				host.readArtifact({ scope, id: "C:/must-not-read.png" }),
			).toThrow("unavailable");
			expect(await host.keepAlive({ scope, id: opened.id })).toBe(true);
			const reopenedUrl = captures[1].previewUrl;
			expect(await host.livePreview({ scope, id: opened.id })).toEqual(live);
			expect(captures[1].isClosed).toBe(true);
			expect((await readPreview(reopenedUrl)).status).toBe(404);
			expect(await host.audio({ scope, id: opened.id })).toBeNull();
			expect(await host.audio({ scope, id: opened.id })).toBeNull();
			expect(captures).toHaveLength(3);
			expect(captures.every((capture) => capture.isClosed)).toBe(true);
			expect(await host.keepAlive({ scope, id: opened.id })).toBe(true);
			await host.closeSession({ scope, id: opened.id });
			expect(
				(
					await fetch(
						`http://127.0.0.1:${liveAddress.port}${liveAddress.pathname}`,
						{ headers: { Host: liveAddress.host } },
					)
				).status,
			).toBe(404);
			await expect(host.livePreview({ scope, id: opened.id })).rejects.toThrow(
				"unavailable",
			);
			await expect(
				host.capture({ scope, id: opened.id, timeSeconds: 0 }),
			).rejects.toThrow("unavailable");
			expect(host.readArtifact({ scope, id: artifact.id }).bytes).toEqual(
				output.bytes,
			);
		} finally {
			await host.close();
			captureSpy.mockRestore();
			runtime.free();
		}
	},
	60_000,
);

test.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"six retained live sources leave capacity for a screenshot and audio probe",
	async () => {
		const runtime = await createCanonicalTestRuntime();
		const host = new HyperframesRenderHost(runtime);
		const scope = { accountId: "account-a", projectId: "project-a" };
		const ids: string[] = [];
		const urls: string[] = [];
		try {
			for (let index = 0; index < 6; index++) {
				const session = await host.open({
					scope,
					source,
					resolveResource: async () => null,
				});
				ids.push(session.id);
				urls.push((await host.livePreview({ scope, id: session.id })).url);
			}
			await expect(
				host.open({ scope, source, resolveResource: async () => null }),
			).rejects.toThrow("Close an existing");
			const screenshot = await host.capture({
				scope,
				id: ids[0],
				timeSeconds: 0,
			});
			expect([screenshot.width, screenshot.height]).toEqual([64, 64]);
			expect(await host.audio({ scope, id: ids[1] })).toBeNull();
			for (const [index, url] of urls.entries()) {
				expect((await readPreview(url)).status).toBe(200);
				expect(await host.keepAlive({ scope, id: ids[index] })).toBe(true);
			}
			await host.closeSession({ scope, id: ids[0] });
			expect((await readPreview(urls[0])).status).toBe(404);
			const replacement = await host.open({
				scope,
				source,
				resolveResource: async () => null,
			});
			expect(
				(await host.livePreview({ scope, id: replacement.id })).url,
			).not.toBe(urls[0]);
		} finally {
			await host.close();
			runtime.free();
		}
	},
	120_000,
);
