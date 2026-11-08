"use client";
import { useEffect, useState } from "react";
import type { PeerStatus } from "./types";
export function PeerSyncSettings() {
	const [status, setStatus] = useState<PeerStatus | null>(null),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	useEffect(() => {
		const accountId = window.__opencutAccountId,
			controller = new AbortController();
		const refresh = async () => {
			try {
				const response = await fetch("/api/accounts/peers", {
					cache: "no-store",
					signal: controller.signal,
				});
				const raw = await response.json();
				if (!response.ok)
					throw new Error(raw.error || "Could not read device status");
				if (window.__opencutAccountId === accountId) setStatus(raw);
			} catch (e) {
				if (!controller.signal.aborted)
					setError(e instanceof Error ? e.message : String(e));
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 10_000);
		return () => {
			clearInterval(timer);
			controller.abort();
		};
	}, []);
	async function configure(enabled: boolean) {
		setBusy(true);
		setError("");
		const accountId = window.__opencutAccountId;
		try {
			const response = await fetch("/api/accounts/peers", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-OpenCut-Account": accountId || "",
				},
				body: JSON.stringify({ action: "configure", enabled }),
			});
			const value = await response.json();
			if (!response.ok) throw new Error(value.error);
			if (window.__opencutAccountId === accountId) setStatus(value);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}
	return (
		<section
			className="space-y-4 rounded-xl border p-6"
			aria-label="Files across your devices"
		>
			<div>
				<h2 className="text-lg font-medium">
					Bring your originals to this computer
				</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					Pull missing project files from another computer signed in to your
					Legitate account. Keep OpenCut open and enable sharing on both
					computers. Your cuts and effects stay in place.
				</p>
			</div>
			<label className="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					checked={status?.enabled ?? false}
					disabled={
						busy ||
						!status ||
						(!status.enabled && (!status.configured || !status.linked))
					}
					onChange={(e) => void configure(e.target.checked)}
				/>
				Allow my devices to pull this account’s project originals
			</label>
			{status && !status.configured && (
				<p className="text-sm text-muted-foreground">
					Device transfers are unavailable on this OpenCut host.
				</p>
			)}
			{status && !status.linked && (
				<p className="text-sm text-muted-foreground">
					Connect Legitate and sign in again to verify that these computers
					belong to the same user.
				</p>
			)}
			{status && (
				<p className="text-sm">
					This computer: {status.deviceName} ·{" "}
					{status.connected
						? "Connected"
						: status.enabled
							? "Not connected"
							: "Sharing off"}
				</p>
			)}
			{status?.enabled && (
				<div className="space-y-2">
					<h3 className="text-sm font-medium">Your online computers</h3>
					{status.devices.length ? (
						<ul className="space-y-1 text-sm">
							{status.devices.map((peer) => (
								<li key={peer.id}>{peer.name}</li>
							))}
						</ul>
					) : (
						<p className="text-sm text-muted-foreground">
							No other computer is online yet.
						</p>
					)}
				</div>
			)}
			{(error || status?.error) && (
				<p role="alert" className="text-sm text-red-500">
					{error || status?.error}
				</p>
			)}
			<p className="text-xs text-muted-foreground">
				Transfers are encrypted between your devices. The relay keeps no media
				library. Stopping sharing cancels active transfers; partial downloads
				can be resumed later.
			</p>
		</section>
	);
}
