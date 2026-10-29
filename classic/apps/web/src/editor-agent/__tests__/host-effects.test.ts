import { expect, spyOn, test } from "bun:test";
import { performHostEffect } from "../host-effects";
import { bindEditorWriteAuthority } from "../write-authority";

test("only a definitive rejection settles a failed host effect", async () => {
	const input = {
		effect: {
			id: 1,
			adapter: "knowledge",
			projectId: "project",
			request: { type: "search" },
		},
		accountId: "alice",
		signal: new AbortController().signal,
	};
	const fetchMock = spyOn(globalThis, "fetch");
	try {
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ error: "Version conflict", definitive: true },
				{ status: 400 },
			),
		);
		expect(await performHostEffect(input)).toEqual({
			type: "rejected",
			message: "Version conflict",
		});
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ error: "Write response lost", definitive: false },
				{ status: 503 },
			),
		);
		await expect(performHostEffect(input)).rejects.toThrow("uncertain");
		fetchMock.mockRejectedValueOnce(new TypeError("Network disconnected"));
		await expect(performHostEffect(input)).rejects.toThrow(
			"Network disconnected",
		);
		await expect(
			performHostEffect({
				...input,
				effect: { ...input.effect, adapter: "https://other.example" },
			}),
		).rejects.toThrow("unavailable");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	} finally {
		fetchMock.mockRestore();
	}
});

test("owned media transport carries the current fence and rejects late foreign-scope publication", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { __opencutAccountId: "alice" },
	});
	let currentProject = "target";
	const release = bindEditorWriteAuthority({
		accountId: "alice",
		projectId: "target",
		read: () => ({ sessionId: "session", generation: 3 }),
	});
	const fetchMock = spyOn(globalThis, "fetch");
	const input = {
		effect: {
			id: 1,
			adapter: "ownedMediaTransfer",
			projectId: "target",
			request: { operationId: "copy-once" },
		},
		accountId: "alice",
		signal: new AbortController().signal,
		activeProjectId: () => currentProject,
	};
	try {
		fetchMock.mockImplementationOnce(
			Object.assign(
				async (
					_url: Parameters<typeof fetch>[0],
					init?: Parameters<typeof fetch>[1],
				) => {
					const headers = new Headers(init?.headers);
					expect(headers.get("X-OpenCut-Editor-Session")).toBe("session");
					expect(headers.get("X-OpenCut-Editor-Generation")).toBe("3");
					expect(JSON.parse(String(init?.body)).copy).toBe(true);
					return Response.json({ mediaId: "copied" });
				},
				{ preconnect: () => {} },
			),
		);
		expect(await performHostEffect(input)).toEqual({
			type: "success",
			data: { mediaId: "copied" },
		});
		fetchMock.mockImplementationOnce(
			Object.assign(
				async () => {
					currentProject = "other";
					return Response.json({ mediaId: "copied" });
				},
				{ preconnect: () => {} },
			),
		);
		await expect(performHostEffect(input)).rejects.toThrow(
			"scope changed after IO",
		);
		expect(await performHostEffect(input)).toEqual({
			type: "rejected",
			message: "The owned-project operation's active scope changed",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	} finally {
		release();
		fetchMock.mockRestore();
		if (previous) Object.defineProperty(globalThis, "window", previous);
		else Reflect.deleteProperty(globalThis, "window");
	}
});

test("computer transport preserves uncertain results and cancels IO on stop", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
	const controller = new AbortController();
	let cancelled = false;
	let reply: unknown = { type: "success", data: { text: "ok" } };
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			__opencutAccountId: "alice",
			opencutElectron: {
				executeComputerOperation: async (request: Record<string, unknown>) => {
					expect(request.accountId).toBe("alice");
					return reply;
				},
				cancelComputerOperations: async () => {
					cancelled = true;
				},
			},
		},
	});
	const input = {
		effect: {
			id: 1,
			adapter: "computer",
			projectId: "project",
			request: {
				projectId: "project",
				operationId: "once",
				generation: 1,
				mode: "askDestructive",
				operation: { type: "list", path: "/tmp" },
			},
		},
		accountId: "alice",
		signal: controller.signal,
		activeProjectId: () => "project",
	};
	try {
		expect(await performHostEffect(input)).toEqual({
			type: "success",
			data: { text: "ok" },
		});
		reply = { type: "rejected", message: "User denied" };
		expect(await performHostEffect(input)).toEqual(reply);
		reply = { type: "uncertain", message: "Response lost" };
		await expect(performHostEffect(input)).rejects.toThrow("uncertain");
		let settle!: (value: unknown) => void;
		window.opencutElectron!.executeComputerOperation = () =>
			new Promise((resolve) => {
				settle = resolve as typeof settle;
			});
		const pending = performHostEffect(input);
		controller.abort();
		settle({ type: "success", data: { text: "committed before stop" } });
		expect((await pending).type).toBe("success");
		expect(cancelled).toBe(true);
	} finally {
		if (previous) Object.defineProperty(globalThis, "window", previous);
		else Reflect.deleteProperty(globalThis, "window");
	}
});
