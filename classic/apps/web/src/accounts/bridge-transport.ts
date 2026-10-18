/** Host transport only. Stale registrations must not multiply large snapshots. */
export function isBridgeProcessAlive({ pid }: { pid: number }): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM does not prove that a process has exited.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export async function settleBridgeRequests<T, R>({
	configs,
	run,
	concurrency = 4,
}: {
	configs: T[];
	run: (config: T) => Promise<R>;
	concurrency?: number;
}): Promise<PromiseSettledResult<R>[]> {
	const results: PromiseSettledResult<R>[] = new Array(configs.length);
	let next = 0;
	await Promise.all(
		Array.from(
			{ length: Math.min(Math.max(1, concurrency), configs.length) },
			async () => {
				while (next < configs.length) {
					const index = next++;
					try {
						results[index] = {
							status: "fulfilled",
							value: await run(configs[index]),
						};
					} catch (reason) {
						results[index] = { status: "rejected", reason };
					}
				}
			},
		),
	);
	return results;
}
