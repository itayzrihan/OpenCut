"use client";
import { useEffect } from "react";
import { toast } from "sonner";

// Scheduling belongs to the client. Its local host performs streaming disk I/O;
// no central service or remote compute is needed while the application is open.
export function BackgroundSnapshots() {
	useEffect(() => {
		let cancelled = false,
			pending = false,
			lastError = "";
		async function tick() {
			if (cancelled || pending) return;
			pending = true;
			try {
				const response = await fetch("/api/accounts/storage", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action: "sync-if-changed" }),
				});
				const result = await response.json();
				if (!response.ok)
					throw new Error(result.error || "Storage is unavailable");
				if (result.started) {
					while (!cancelled) {
						await new Promise((resolve) => setTimeout(resolve, 3000));
						if (cancelled) break;
						const status = await fetch("/api/accounts/storage?status=1", {
							cache: "no-store",
						});
						const current = await status.json();
						if (!status.ok)
							throw new Error(current.error || "Cannot read storage progress");
						if (current.job?.status === "running") continue;
						if (current.job?.status === "failed")
							throw new Error(
								current.job.error ||
									"Snapshot did not finish; local work is preserved",
							);
						break;
					}
				}
				lastError = "";
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!cancelled && message !== lastError)
					toast.error(`Automatic storage check: ${message}`);
				lastError = message;
			} finally {
				pending = false;
			}
		}
		const initial = setTimeout(() => void tick(), 60_000);
		const periodic = setInterval(() => void tick(), 5 * 60_000);
		return () => {
			cancelled = true;
			clearTimeout(initial);
			clearInterval(periodic);
		};
	}, []);
	return null;
}
