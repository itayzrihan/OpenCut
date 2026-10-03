/** ONNX platform resource ownership, scoped to one Whisper generation window.
 * Transformers 4.3 can retain encoder/attention/KV GPU outputs between windows
 * (upstream issue #1739). The ASR pipeline only consumes CPU tokens/timestamps
 * after generate() returns, so release remaining session outputs at that boundary.
 * Model weights belong to the sessions and are never part of this output set.
 */
interface SessionTensor {
	location: string;
	dispose(): void;
}
interface WhisperSessions {
	sessions: Record<
		string,
		{ run: (...args: unknown[]) => Promise<Record<string, SessionTensor>> }
	>;
	generate: (...args: unknown[]) => Promise<unknown>;
}

export function boundWhisperGpuOutputs(value: unknown): void {
	const model = value as WhisperSessions;
	const outputs = new Set<SessionTensor>();
	let generating = false;
	for (const session of Object.values(model.sessions)) {
		const run = session.run.bind(session);
		session.run = async (...args) => {
			const result = await run(...args);
			if (generating)
				for (const tensor of Object.values(result)) {
					if (tensor.location === "gpu-buffer") outputs.add(tensor);
				}
			return result;
		};
	}
	const generate = model.generate.bind(model);
	model.generate = async (...args) => {
		if (generating)
			throw new Error("Concurrent Whisper generation is unsupported");
		generating = true;
		try {
			return await generate(...args);
		} finally {
			generating = false;
			for (const tensor of outputs) {
				// ONNX marks outputs already released by generation as location=none.
				if (tensor.location === "gpu-buffer") tensor.dispose();
			}
			outputs.clear();
		}
	};
}
