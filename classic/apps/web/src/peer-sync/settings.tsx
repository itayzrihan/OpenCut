"use client";
import {
	LocalizedElement as UiLocalized,
	Message as UiMessage,
} from "@/i18n/message";
import { useEffect, useState } from "react";
import { MonitorDown } from "lucide-react";
import styles from "@/accounts/settings.module.css";
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
		<UiLocalized<"section">
			element={"section"}
			messageProps={["aria-label"]}
			className={styles.card}
			aria-label="Files across your devices"
		>
			<div>
				<h3 className={styles.heading}>
					<MonitorDown className="size-4 text-primary" aria-hidden="true" />
					<UiMessage text={"Bring your originals to this computer"} />
				</h3>
				<p className="mt-2 text-sm text-muted-foreground">
					<UiMessage
						text={
							"Pull missing project files from another computer signed in to your Legitate account. Keep POCUT open and enable sharing on both computers. Your cuts and effects stay in place."
						}
					/>
				</p>
			</div>
			<label className="flex items-center gap-3 rounded-lg border bg-background/55 p-3 text-sm">
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
				<UiMessage
					text={"Allow my devices to pull this account’s project originals"}
				/>
			</label>
			{status && !status.configured && (
				<p className="text-sm text-muted-foreground">
					<UiMessage
						text={"Device transfers are unavailable on this POCUT host."}
					/>
				</p>
			)}
			{status && !status.linked && (
				<p className="text-sm text-muted-foreground">
					<UiMessage
						text={
							"Connect Legitate and sign in again to verify that these computers belong to the same user."
						}
					/>
				</p>
			)}
			{status && (
				<p className="text-sm">
					<UiMessage text={"This computer:"} /> {status.deviceName} ·{" "}
					{status.connected ? (
						<UiMessage text={"Connected"} />
					) : status.enabled ? (
						<UiMessage text={"Not connected"} />
					) : (
						<UiMessage text={"Sharing off"} />
					)}
				</p>
			)}
			{status?.enabled && (
				<div className="space-y-2">
					<h3 className="text-sm font-medium">
						<UiMessage text={"Your online computers"} />
					</h3>
					{status.devices.length ? (
						<ul className="space-y-1 text-sm">
							{status.devices.map((peer) => (
								<li key={peer.id}>{peer.name}</li>
							))}
						</ul>
					) : (
						<p className="text-sm text-muted-foreground">
							<UiMessage text={"No other computer is online yet."} />
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
				<UiMessage
					text={
						"Transfers are encrypted between your devices. The relay keeps no media library. Stopping sharing cancels active transfers; partial downloads can be resumed later."
					}
				/>
			</p>
		</UiLocalized>
	);
}
