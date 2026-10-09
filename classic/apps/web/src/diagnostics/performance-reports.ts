/** Bounded, local-only diagnostics. No documents, media URLs, or account data. */
export type PerformanceReport = { kind: string; at: number; data: unknown };
const reports: PerformanceReport[] = [];
const listeners = new Set<() => void>();
const MAX_REPORTS = 120;

export function publishPerformanceReport({
	kind,
	data,
}: {
	kind: string;
	data: unknown;
}): void {
	reports.push({ kind, at: Date.now(), data });
	if (reports.length > MAX_REPORTS)
		reports.splice(0, reports.length - MAX_REPORTS);
	for (const listener of listeners) listener();
}

export function readPerformanceReports(): readonly PerformanceReport[] {
	return reports;
}
export function subscribePerformanceReports(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
