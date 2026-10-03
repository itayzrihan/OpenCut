import { expect, test } from "bun:test";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { HyperframesRenderHost } from "../render-host";

test.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"real host scopes sessions and artifacts to the exact account and project",
	async () => {
		const runtime = await createCanonicalTestRuntime();
		const host = new HyperframesRenderHost(runtime);
		const scope = { accountId: "account-a", projectId: "project-a" };
		try {
			const opened = await host.open({
				scope,
				source: {
					entryFile: "scene.html",
					resourceAssetIds: {},
					files: {
						"scene.html":
							'<!doctype html><html><body style="margin:0"><div data-composition-id="test" data-no-timeline data-width="64" data-height="64" data-duration="2" style="width:64px;height:64px;background:red"></div></body></html>',
					},
				},
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
			}
			const artifact = await host.capture({
				scope,
				id: opened.id,
				timeSeconds: 0,
			});
			const output = host.readArtifact({ scope, id: artifact.id });
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
			await host.closeSession({ scope, id: opened.id });
			await expect(
				host.capture({ scope, id: opened.id, timeSeconds: 0 }),
			).rejects.toThrow("unavailable");
			expect(host.readArtifact({ scope, id: artifact.id }).bytes).toEqual(
				output.bytes,
			);
		} finally {
			await host.close();
			runtime.free();
		}
	},
	60_000,
);
