import { expect, spyOn, test } from "bun:test";
import type { EditorCore } from "@/core";
import { performPeerMediaEffect } from "./editor-effect";
import { invokePeerMedia } from "./editor-client";
import { bindEditorWriteAuthority } from "@/editor-agent/write-authority";
import { mockFetch } from "@/test-support/mock-fetch";

const job = {
	projectId: "project",
	mediaId: "media",
	deviceId: "laptop",
	operationId: "pull-1",
	expectedBindingRevision: 2,
	status: "ready",
	phase: "ready",
	receivedBytes: 10,
	totalBytes: 10,
};
function fixture() {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { __opencutAccountId: "alice" },
	});
	let project = "project",
		revision = 1;
	const assets = [
		{ id: "media", missing: true, bindingRevision: 2, sourcePath: "old.mp4" },
	];
	const links: unknown[] = [];
	const editor = {
		project: { getActiveOrNull: () => ({ metadata: { id: project } }) },
		command: {
			getCanonicalRevision: () => revision,
			enableCanonical: async () => {},
		},
		media: {
			getAssets: () => assets,
			relink: async (input: { source: string }) => {
				links.push(input);
				Object.assign(assets[0], {
					sourcePath: input.source,
					missing: false,
					bindingRevision: 3,
				});
				revision++;
			},
		},
	} as unknown as EditorCore;
	const release = bindEditorWriteAuthority({
		accountId: "alice",
		projectId: "project",
		read: () => ({ sessionId: "session", generation: 3 }),
	});
	return {
		editor,
		links,
		project: (id: string) => {
			project = id;
		},
		revision: (n: number) => {
			revision = n;
		},
		restore: () => {
			release();
			if (previous) Object.defineProperty(globalThis, "window", previous);
			else Reflect.deleteProperty(globalThis, "window");
		},
	};
}
test("commit uses the verified source, existing media ID and binding fence without exposing paths to the agent", async () => {
	const f = fixture(),
		fetchMock = spyOn(globalThis, "fetch");
	try {
		fetchMock.mockResolvedValue(
			Response.json({ job, source: "C:\\owned\\verified-original.mp4" }),
		);
		const result = await performPeerMediaEffect({
			editor: f.editor,
			accountId: "alice",
			signal: new AbortController().signal,
			effect: {
				id: 1,
				adapter: "peerMedia",
				projectId: "project",
				request: {
					operation: "commit",
					input: { projectId: "project", operationId: "pull-1" },
				},
			},
		});
		expect(f.links).toEqual([
			{
				projectId: "project",
				id: "media",
				source: "C:\\owned\\verified-original.mp4",
				expectedRevision: 2,
				requestId: "pull-1",
			},
		]);
		expect(result.type).toBe("success");
		expect(JSON.stringify(result)).toContain('"linked":true');
		expect(JSON.stringify(result)).not.toContain("C:");
		const headers = fetchMock.mock.calls[0][1]?.headers as Record<
			string,
			string
		>;
		expect(headers["X-OpenCut-Editor-Session"]).toBe("session");
		expect(headers["X-OpenCut-Account"]).toBe("alice");
	} finally {
		fetchMock.mockRestore();
		f.restore();
	}
});
test("a late account/project change or wrong job scope cannot publish the downloaded original", async () => {
	for (const mode of ["account", "project", "job"]) {
		const f = fixture(),
			fetchMock = spyOn(globalThis, "fetch");
		try {
			fetchMock.mockImplementation(
				mockFetch(async () => {
					if (mode === "account") window.__opencutAccountId = "bob";
					if (mode === "project") f.project("other");
					return Response.json({
						source: "C:\\owned\\verified-original.mp4",
						job: mode === "job" ? { ...job, projectId: "other" } : job,
					});
				}),
			);
			await expect(
				performPeerMediaEffect({
					editor: f.editor,
					accountId: "alice",
					signal: new AbortController().signal,
					effect: {
						id: 1,
						adapter: "peerMedia",
						projectId: "project",
						request: {
							operation: "commit",
							input: { projectId: "project", operationId: "pull-1" },
						},
					},
				}),
			).rejects.toThrow();
			expect(f.links).toEqual([]);
		} finally {
			fetchMock.mockRestore();
			f.restore();
		}
	}
});
test("a lost acceptance reply replays the exact invocation before reading jobs, even after timeline edits", async () => {
	const f = fixture(),
		fetchMock = spyOn(globalThis, "fetch");
	const calls: Array<{
		capabilityId: string;
		input: Record<string, unknown>;
		context: unknown;
	}> = [];
	f.editor.command.invokeCanonicalMcp = (async (
		options: Parameters<EditorCore["command"]["invokeCanonicalMcp"]>[0],
	) => {
		calls.push({
			capabilityId: options.capabilityId,
			input: structuredClone(options.input),
			context: structuredClone(options.context),
		});
		const result = await options.host({
			id: calls.length,
			adapter: "peerMedia",
			projectId: options.projectId,
			request: {
				operation:
					options.capabilityId === "media.transfer.start"
						? "start"
						: "transfers",
				input: options.input,
			},
		});
		if (result.type === "rejected") throw new Error(result.message);
		return {
			output: result.data,
			artifacts: [],
			applied: false,
			revision: f.editor.command.getCanonicalRevision()!,
		};
	}) as EditorCore["command"]["invokeCanonicalMcp"];
	try {
		fetchMock.mockRejectedValueOnce(new TypeError("Acceptance reply lost"));
		await expect(
			invokePeerMedia({
				editor: f.editor,
				capabilityId: "media.transfer.start",
				input: {
					mediaId: "media",
					deviceId: "laptop",
					operationId: "pull-1",
					expectedBindingRevision: 2,
				},
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("lost");
		f.revision(9);
		fetchMock.mockResolvedValueOnce(
			Response.json({ job: { ...job, status: "running" } }),
		);
		fetchMock.mockResolvedValueOnce(
			Response.json({ jobs: [{ ...job, status: "running" }] }),
		);
		const result = await invokePeerMedia({
			editor: f.editor,
			capabilityId: "media.transfer.list",
			signal: new AbortController().signal,
		});
		expect(calls).toHaveLength(3);
		expect(calls[1]).toEqual(calls[0]);
		expect(calls[2].input.expectedRevision).toBe(9);
		expect(result.jobs[0].operationId).toBe("pull-1");
	} finally {
		fetchMock.mockRestore();
		f.restore();
	}
});
