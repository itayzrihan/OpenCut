import type { SessionView } from "./model";
export class RuntimeClient {
	private worker = new Worker(new URL("./runtime.worker.ts", import.meta.url), {
		type: "module",
	});
	private next = 0;
	private pending = new Map<
		number,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();
	constructor() {
		this.worker.onmessage = ({ data }) => {
			const task = this.pending.get(data.id);
			if (!task) return;
			this.pending.delete(data.id);
			if (data.error) task.reject(Error(data.error));
			else task.resolve(data.value);
		};
		this.worker.onerror = (event) => {
			for (const p of this.pending.values())
				p.reject(Error(event.message || "Editor worker failed"));
			this.pending.clear();
		};
	}
	request<T = SessionView>(message: Record<string, unknown>): Promise<T> {
		return new Promise((resolve, reject) => {
			const id = ++this.next;
			this.pending.set(id, { resolve, reject });
			this.worker.postMessage({ ...message, id });
		});
	}
	dispose() {
		this.worker.terminate();
		for (const p of this.pending.values()) p.reject(Error("Editor closed"));
		this.pending.clear();
	}
}
