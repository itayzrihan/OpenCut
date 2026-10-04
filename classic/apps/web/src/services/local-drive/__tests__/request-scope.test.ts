import { expect, spyOn, test } from "bun:test";
import { setBatchWriteToken } from "@/batch/write-token";
import { localDriveRequest, localMediaUrl, uploadLocalMedia } from "../client";

test("folder uploads and rollback keep the initiating account and cancellation signal", async () => {
	const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			__opencutAccountId: "account-after-switch",
			location: { origin: "http://localhost" },
		},
	});
	const calls: Array<{ url: string; options?: RequestInit }> = [];
	const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
		// eslint-disable-next-line opencut/prefer-object-params -- Browser fetch signature.
		(async (url: RequestInfo | URL, options?: RequestInit) => {
			calls.push({ url: String(url), options });
			options?.signal?.throwIfAborted();
			return Response.json({ ok: true });
		}) as typeof fetch,
	);
	const controller = new AbortController();
	const scope = {
		accountId: "account-before-switch",
		signal: controller.signal,
		uploadToken: "owned-upload-token",
	};
	setBatchWriteToken("test-write-lease");
	try {
		const file = new File(["image"], "image.png", { type: "image/png" });
		await uploadLocalMedia({ projectId: "project", id: "asset", file, scope });
		await localDriveRequest({
			operation: "media.put",
			payload: { projectId: "project" },
			scope,
		});
		for (const call of calls) {
			const headers = new Headers(call.options?.headers);
			expect(headers.get("X-OpenCut-Account")).toBe(scope.accountId);
			expect(headers.get("X-OpenCut-Batch-Token")).toBe("test-write-lease");
			expect(call.options?.signal).toBe(controller.signal);
		}
		expect(calls[0].options?.body).toBe(file);
		expect(new Headers(calls[0].options?.headers).get("X-OpenCut-Upload")).toBe(
			scope.uploadToken,
		);
		expect(
			localMediaUrl({
				projectId: "project",
				id: "asset",
				accountId: scope.accountId,
			}),
		).toContain("account=account-before-switch");
		controller.abort();
		await expect(
			uploadLocalMedia({ projectId: "project", id: "asset", file, scope }),
		).rejects.toThrow();
		await localDriveRequest({
			operation: "media.delete",
			payload: { projectId: "project", id: "asset" },
			scope: { accountId: scope.accountId },
		});
		expect(calls.at(-1)?.options?.signal).toBeUndefined();
		expect(
			new Headers(calls.at(-1)?.options?.headers).get("X-OpenCut-Account"),
		).toBe(scope.accountId);
	} finally {
		setBatchWriteToken("");
		fetchMock.mockRestore();
		if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
		else Reflect.deleteProperty(globalThis, "window");
	}
});
