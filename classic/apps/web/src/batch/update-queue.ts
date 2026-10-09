/** Serialize host IO while replacing obsolete, unsent progress updates.
 * Lifecycle events stay ordered and are never coalesced. */
export function createBatchUpdateQueue<T>(
	exchange: (data: Record<string, unknown>) => Promise<T>,
) {
	let tail: Promise<unknown> = Promise.resolve();
	let pending:
		| { entry: { data: Record<string, unknown> }; promise: Promise<T> }
		| undefined;
	// eslint-disable-next-line opencut/prefer-object-params -- Payload and coalescing mirror a serialized transport send.
	const send = (
		data: Record<string, unknown> = {},
		coalesce = false,
	): Promise<T> => {
		if (
			coalesce &&
			pending &&
			(data.projectId === undefined ||
				pending.entry.data.projectId === data.projectId)
		) {
			pending.entry.data = { ...pending.entry.data, ...data };
			return pending.promise;
		}
		const entry = { data };
		const promise = tail.then(() => {
			if (pending?.entry === entry) pending = undefined;
			return exchange(entry.data);
		});
		tail = promise.catch(() => {});
		// Never replace an update that precedes a queued lifecycle event.
		pending = coalesce ? { entry, promise } : undefined;
		return promise;
	};
	return Object.assign(send, {
		flush: async () => {
			for (;;) {
				const current = tail;
				await current;
				if (current === tail) return;
			}
		},
	});
}
