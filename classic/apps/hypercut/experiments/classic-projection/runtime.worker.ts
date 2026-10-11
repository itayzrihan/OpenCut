import * as glue from "../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js";
import wasmUrl from "../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.wasm?url";
import { RuntimeSession, type Runtime } from "./runtime-session";
import { readStore, writeStore } from "./storage";
let session: RuntimeSession | undefined;
let release: (() => void) | undefined;
const initialized = (async () => {
	const bytes = await (await fetch(wasmUrl)).arrayBuffer();
	const { instance } = await WebAssembly.instantiate(bytes, {
		"./opencut_editor_runtime_wasm_bg.js": glue,
	});
	glue.__wbg_set_wasm(instance.exports);
	(instance.exports.__wbindgen_start as () => void)();
})();
async function persist() {
	if (!session) throw Error("Open a project first");
	const s = session.snapshot();
	await writeStore("projects", {
		id: session.projectId,
		name: s.project.classic.document.metadata.name,
		updatedAt: Date.now(),
		archive: session.archive(),
	});
}
async function handle(message: any) {
	await initialized;
	if (message.kind === "open") {
		if (session)
			throw Error("Close the current session before opening another.");
		await new Promise<void>((resolve, reject) => {
			void navigator.locks
				.request(
					`hypercut:${message.projectId}`,
					{ ifAvailable: true },
					async (lock) => {
						if (!lock) {
							reject(
								Error(
									"This HyperCut project is open in another tab. Close that tab and try again.",
								),
							);
							return;
						}
						await new Promise<void>((done) => {
							release = done;
							resolve();
						});
					},
				)
				.catch(reject);
		});
		try {
			const saved = await readStore<{ archive: unknown }>(
				"projects",
				message.projectId,
			);
			session = new RuntimeSession(
				new glue.CanonicalEditorRuntime() as unknown as Runtime,
				message.projectId,
			);
			session.open(message.name, saved?.archive);
			if (!saved) await persist();
			return session.view();
		} catch (error) {
			session?.runtime.free();
			session = undefined;
			release?.();
			release = undefined;
			throw error;
		}
	}
	if (!session) throw Error("Open a project first");
	if (message.kind === "invoke") {
		const result = session.invoke(
			message.capability,
			message.input,
			message.expectedRevision,
		);
		try {
			await persist();
			return { ...session.view(), result };
		} catch (error) {
			return { ...session.view(false), result, storageError: String(error) };
		}
	}
	if (message.kind === "save") {
		await persist();
		return session.view();
	}
	if (message.kind === "close") {
		await persist();
		session.runtime.free();
		session = undefined;
		release?.();
		release = undefined;
		return null;
	}
	throw Error("Unknown worker operation");
}
// One FIFO owns canonical state. Concurrent clicks cannot race restore/save/mutations.
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
	queue = queue.then(async () => {
		try {
			const value = await handle(data);
			self.postMessage({ id: data.id, value });
		} catch (error) {
			self.postMessage({
				id: data.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
};
