export class RenderQueue {
	private tail: Promise<void> = Promise.resolve();

	run<T>(task: () => Promise<T> | T): Promise<T> {
		const result = this.tail.then(task);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

export const compositorRenderQueue = new RenderQueue();
