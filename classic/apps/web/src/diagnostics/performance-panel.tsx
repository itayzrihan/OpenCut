"use client";
import { useEffect, useState } from "react";
import { isRenderPerfEnabled } from "./render-perf";
import {
	publishPerformanceReport,
	readPerformanceReports,
	subscribePerformanceReports,
} from "./performance-reports";

/** Opt-in developer view: the displayed/exported data survives console stripping. */
export function PerformancePanel() {
	const [enabled, setEnabled] = useState(false);
	const [report, setReport] = useState("[]");
	useEffect(() => {
		const initial = setTimeout(() => {
			setEnabled(isRenderPerfEnabled());
			update();
		}, 0);
		const update = () =>
			setReport(JSON.stringify(readPerformanceReports(), null, 2));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const unsubscribe = subscribePerformanceReports(() => {
			timer ??= setTimeout(() => {
				timer = undefined;
				update();
			}, 1000);
		});
		let observer: PerformanceObserver | undefined;
		if (
			isRenderPerfEnabled() &&
			typeof PerformanceObserver !== "undefined" &&
			PerformanceObserver.supportedEntryTypes.includes("longtask")
		) {
			observer = new PerformanceObserver((list) => {
				const durations = list.getEntries().map((entry) => entry.duration);
				publishPerformanceReport({
					kind: "main-thread-long-tasks",
					data: {
						count: durations.length,
						totalMs: durations.reduce((a, b) => a + b, 0),
						maxMs: Math.max(...durations),
					},
				});
			});
			observer.observe({ type: "longtask" });
		}
		return () => {
			clearTimeout(initial);
			unsubscribe();
			observer?.disconnect();
			clearTimeout(timer);
		};
	}, []);
	if (!enabled) return null;
	return (
		<details className="fixed bottom-3 right-3 z-50 max-w-lg rounded border bg-background p-2 text-xs">
			<summary>Preview performance · local diagnostics</summary>
			<p>
				Completed renders, not physical display FPS. No media or project
				contents.
			</p>
			<button
				type="button"
				onClick={() => {
					const url = URL.createObjectURL(
						new Blob([report], { type: "application/json" }),
					);
					const link = document.createElement("a");
					link.href = url;
					link.download = "opencut-preview-performance.json";
					link.click();
					setTimeout(() => URL.revokeObjectURL(url), 1000);
				}}
			>
				Download measurements
			</button>
			<pre
				data-testid="preview-performance-reports"
				className="max-h-72 overflow-auto"
			>
				{report}
			</pre>
		</details>
	);
}
