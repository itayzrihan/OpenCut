/** Bound provider work across tabs without serializing unrelated account writes. */
export function createTranscriptionLimit() {
	const active = new Map<string, number>();
	return async ({
		account,
		run,
	}: {
		account: string;
		run: () => Promise<Response>;
	}) => {
		const count = active.get(account) ?? 0;
		if (count >= 2)
			return Response.json(
				{ error: "Two transcription sections are already running" },
				{ status: 429, headers: { "Retry-After": "2" } },
			);
		active.set(account, count + 1);
		try {
			return await run();
		} finally {
			const remaining = (active.get(account) ?? 1) - 1;
			if (remaining) active.set(account, remaining);
			else active.delete(account);
		}
	};
}
