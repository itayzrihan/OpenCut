"use client";
import { useEffect } from "react";
/** Authenticated presence expires when OpenCut closes or this account changes. */
export function PeerSyncPresence() {
	useEffect(() => {
		const accountId = window.__opencutAccountId;
		if (!accountId) return;
		let disposed = false,
			pending = false;
		const heartbeat = async () => {
			if (disposed || pending || window.__opencutAccountId !== accountId)
				return;
			pending = true;
			try {
				await fetch("/api/accounts/peers", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-OpenCut-Account": accountId,
					},
					body: JSON.stringify({ action: "heartbeat" }),
					cache: "no-store",
					signal: AbortSignal.timeout(20_000),
				});
			} catch {
				/* Connection errors are shown in the explicit device settings. */
			} finally {
				pending = false;
			}
		};
		void heartbeat();
		const timer = setInterval(() => void heartbeat(), 15_000);
		return () => {
			disposed = true;
			clearInterval(timer);
			// No beacon or credentials are sent to an external origin. A missed local
			// cleanup still expires after the bounded authenticated presence lease.
			void fetch("/api/accounts/peers", {
				method: "POST",
				keepalive: true,
				headers: {
					"Content-Type": "application/json",
					"X-OpenCut-Account": accountId,
				},
				body: JSON.stringify({ action: "disconnect" }),
			}).catch(() => {});
		};
	}, []);
	return null;
}
