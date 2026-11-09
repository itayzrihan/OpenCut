"use client";
import { LocalizedValue as UiValue } from "@/i18n/message";
import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import brand from "@/components/landing/pocut-brand.module.css";
import { saveAllAccountPreferences } from "@/services/local-drive/preferences";
import styles from "./settings.module.css";
type StorageMode = "localOnly" | "externalDrive" | "personalDevices";
type State = {
	profile: {
		folder: string | null;
		deviceId: string;
		account: { storage: { mode: StorageMode; automaticSnapshots?: boolean } };
	};
	currentDevice: { id: string; name: string; fingerprint: string };
	devices: {
		id: string;
		name: string;
		fingerprint: string;
		lastSeenAt: string;
	}[];
	connection: {
		status: "local" | "connected" | "unavailable";
		error: string | null;
	};
	snapshots: {
		id: string;
		createdAt: string;
		files: number;
		bytes: number;
		deviceId: string;
	}[];
	job: {
		action: string;
		status: string;
		files: number;
		total: number;
		error?: string;
	} | null;
};
export function StorageSettings({
	legitateOnly = false,
}: {
	legitateOnly?: boolean;
}) {
	const [state, setState] = useState<State | null>(null),
		[folder, setFolder] = useState(""),
		[password, setPassword] = useState("");
	const [error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	const [automatic, setAutomatic] = useState(false);
	const [metadataOnly, setMetadataOnly] = useState(false);
	const [mode, setMode] = useState<StorageMode>("localOnly"),
		[deviceName, setDeviceName] = useState("");
	async function refresh(statusOnly = false) {
		const response = await fetch(
				`/api/accounts/storage${statusOnly ? "?status=1" : ""}`,
				{ cache: "no-store" },
			),
			result = await response.json();
		if (!response.ok) throw new Error(result.error);
		setState((previous) => ({ ...previous, ...result }));
		if (!statusOnly) {
			setFolder(result.profile.folder ?? "");
			setAutomatic(result.profile.account.storage.automaticSnapshots ?? false);
			setMode(result.profile.account.storage.mode);
			setDeviceName(result.currentDevice.name);
		}
		if (statusOnly && result.job?.status !== "running") {
			if (
				result.job?.action === "restore" &&
				result.job.status === "complete"
			) {
				window.location.reload();
				return;
			}
			await refresh();
		}
	}
	useEffect(() => {
		void refresh().catch((error) => setError(error.message));
	}, []);
	useEffect(() => {
		if (state?.job?.status !== "running") return;
		const timer = setInterval(
			() => void refresh(true).catch((error) => setError(error.message)),
			1500,
		);
		return () => clearInterval(timer);
	}, [state?.job?.status]);
	async function action(body: Record<string, unknown>) {
		setBusy(true);
		setError("");
		try {
			if (body.action === "publish" || body.action === "restore")
				await saveAllAccountPreferences();
			const response = await fetch("/api/accounts/storage", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response.ok) throw new Error((await response.json()).error);
			if (body.action === "export-identity") {
				const blob = await response.blob(),
					url = URL.createObjectURL(blob),
					anchor = document.createElement("a");
				anchor.href = url;
				anchor.download = "POCUT-account-recovery.json";
				anchor.click();
				setTimeout(() => URL.revokeObjectURL(url), 30_000);
				setPassword("");
			} else await refresh();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}
	const running = state?.job?.status === "running",
		disabled = busy || running;
	return (
		<section className={styles.card}>
			<div>
				<h3 className={styles.heading}>
					<HardDrive className="size-4 text-primary" aria-hidden="true" />
					<UiMessage text={"Your storage"} />
				</h3>
				<p className="mt-2 text-sm text-muted-foreground">
					<UiMessage
						text={
							"Keep work local, or save encrypted versions to an external drive, a drive provider’s synced folder, or a mounted folder shared by one of your machines. POCUT keeps a separate account vault outside Git."
						}
					/>
				</p>
			</div>
			<fieldset className="space-y-2" disabled={disabled}>
				<legend className="mb-2 text-sm font-medium">
					<UiMessage text={"Where to keep saved versions"} />
				</legend>
				<div className="grid gap-2 sm:grid-cols-3">
					{(
						[
							["localOnly", "Local only", "Work on this computer."],
							[
								"externalDrive",
								"External drive",
								"Use a drive or provider’s synced folder.",
							],
							[
								"personalDevices",
								"My machines",
								"Use a folder shared by one of your computers.",
							],
						] as const
					).map(([value, label, description]) => (
						<label
							key={value}
							className={`min-w-0 cursor-pointer rounded-lg border p-3 text-sm transition-colors hover:border-primary/60 ${mode === value ? "border-primary/70 bg-primary/10" : "bg-background/60"}`}
						>
							<span className="flex items-center gap-2 font-medium">
								<input
									type="radio"
									name="storage-mode"
									value={value}
									checked={mode === value}
									onChange={() => setMode(value)}
								/>
								<UiMessage text={label} />
							</span>
							<span className="mt-2 block text-xs text-muted-foreground">
								<UiMessage text={description} />
							</span>
						</label>
					))}
				</div>
			</fieldset>
			{mode !== "localOnly" && (
				<>
					{mode === "personalDevices" && (
						<p className="text-sm text-muted-foreground">
							<UiMessage
								text={
									"Choose a folder on this machine, or a mounted share from another machine you own. To connect another computer, recover this account there and select the same shared folder. The machine hosting the share must be reachable when saving or opening versions."
								}
							/>
						</p>
					)}
					<label className="block space-y-1 text-sm">
						<span>
							{mode === "personalDevices" ? (
								<UiMessage text={"Shared folder on your machine"} />
							) : (
								<UiMessage text={"Existing storage folder"} />
							)}
						</span>
						<UiLocalized<typeof Input>
							element={Input}
							messageProps={["placeholder"]}
							value={folder}
							onChange={(event) => setFolder(event.target.value)}
							placeholder="Full path to your drive or mounted share"
							disabled={disabled}
						/>
					</label>
					<label className="block space-y-1 text-sm">
						<span>
							<UiMessage text={"Name for this machine"} />
						</span>
						<Input
							value={deviceName}
							onChange={(event) => setDeviceName(event.target.value)}
							maxLength={128}
							disabled={disabled}
						/>
					</label>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={automatic}
							onChange={(event) => setAutomatic(event.target.checked)}
							disabled={disabled}
						/>
						<UiMessage
							text={
								"Automatically save changed work every five minutes while POCUT is open"
							}
						/>
					</label>
				</>
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					disabled={
						disabled ||
						!state ||
						(mode !== "localOnly" && (!folder.trim() || !deviceName.trim()))
					}
					onClick={() =>
						void action({
							action: "configure",
							folder: mode === "localOnly" ? null : folder.trim(),
							mode,
							deviceName: deviceName.trim(),
							automaticSnapshots: automatic,
						})
					}
					className={brand.primary}
				>
					<UiMessage text={"Save storage choice"} />
				</Button>
				{state?.profile.folder && (
					<Button
						variant="outline"
						disabled={disabled || state.connection.status !== "connected"}
						onClick={() => void action({ action: "publish" })}
					>
						<UiMessage text={"Save encrypted snapshot"} />
					</Button>
				)}
			</div>
			<p className="break-words rounded-lg border bg-background/55 p-3 text-sm text-muted-foreground">
				{state?.connection.status === "unavailable" ? (
					<UiMessage
						text={
							"Destination unavailable: {v0}. Your local workspace remains available."
						}
						values={{ v0: String(state.profile.folder) }}
					/>
				) : state?.profile.folder ? (
					<UiMessage
						text={"Connected: {v0}"}
						values={{ v0: String(state.profile.folder) }}
					/>
				) : (
					<UiMessage text={"Local only. Your work stays on this machine."} />
				)}
			</p>
			{state?.connection.error && (
				<p role="status" className="break-words text-sm text-amber-600">
					{state.connection.error}
				</p>
			)}
			<Button
				variant="outline"
				size="sm"
				className="w-fit"
				disabled={disabled}
				onClick={() => void refresh().catch((error) => setError(error.message))}
			>
				<UiMessage text={"Refresh connection and versions"} />
			</Button>
			{!!state?.devices.length && (
				<div className="space-y-2">
					<h3 className="font-medium">
						<UiMessage text={"Machines using this vault"} />
					</h3>
					<p className="text-xs text-muted-foreground">
						<UiMessage
							text={
								"These identities were verified from the shared vault. The last connection or save does not indicate whether a machine is online now."
							}
						/>
					</p>
					<ul className="space-y-2">
						{state.devices.map((device) => (
							<li key={device.id} className="rounded border p-3 text-sm">
								<p className="font-medium">
									{device.name}
									{device.id === state.currentDevice.id ? (
										<>
											{" "}
											<UiMessage text={"(this machine)"} />
										</>
									) : (
										""
									)}
								</p>
								<p className="text-xs text-muted-foreground">
									<UiMessage text={"Last connection or save:"} />{" "}
									{new Date(device.lastSeenAt).toLocaleString()}
								</p>
								<details className="mt-1 text-xs">
									<summary className="cursor-pointer">
										<UiMessage text={"Device fingerprint"} />
									</summary>
									<code className="break-all">{device.fingerprint}</code>
								</details>
							</li>
						))}
					</ul>
				</div>
			)}
			{running && (
				<div className="flex items-center gap-4">
					<p role="status">
						{state.job?.action === "restore" ? (
							<UiMessage text={"Restoring"} />
						) : (
							<UiMessage text={"Encrypting and verifying"} />
						)}
						: {state.job?.files} / {state.job?.total || "…"}{" "}
						<UiMessage text={"files"} />
					</p>
					<Button
						variant="outline"
						size="sm"
						onClick={() => void action({ action: "cancel" })}
					>
						<UiMessage text={"Cancel"} />
					</Button>
				</div>
			)}
			{state?.job && !running && (
				<p role="status" className="text-sm">
					{state.job.status === "complete" ? (
						<UiMessage text={"Operation completed and verified."} />
					) : (
						(state.job.error ?? state.job.status)
					)}
				</p>
			)}
			{state?.snapshots.length ? (
				<div className="space-y-3">
					<h3 className="font-medium">
						<UiMessage text={"Saved versions"} />
					</h3>
					<label className="flex gap-2 text-sm">
						<input
							type="checkbox"
							checked={metadataOnly}
							onChange={(event) => setMetadataOnly(event.target.checked)}
						/>
						<UiMessage
							text={
								"Open projects without downloading source media (offline editing)"
							}
						/>
					</label>
					<p className="text-xs text-muted-foreground">
						<UiMessage
							text={
								"Versions from every connected machine remain separate. Opening a version first saves your current work as an encrypted version and retains its local files."
							}
						/>
					</p>
					<ul className="space-y-2">
						{state.snapshots.map((snapshot) => (
							<li
								key={snapshot.id}
								className="flex items-center justify-between gap-3 rounded border p-3 text-sm"
							>
								<span>
									<span className="block font-medium">
										{state.devices.find(
											(device) => device.id === snapshot.deviceId,
										)?.name ?? (
											<UiMessage
												text={"Machine {v0}"}
												values={{ v0: String(snapshot.deviceId.slice(0, 8)) }}
											/>
										)}
										{snapshot.deviceId === state.currentDevice.id ? (
											<>
												{" "}
												<UiMessage text={"(this machine)"} />
											</>
										) : (
											""
										)}
									</span>
									{new Date(snapshot.createdAt).toLocaleString()} ·{" "}
									{snapshot.files} <UiMessage text={"files ·"} />{" "}
									{(snapshot.bytes / 1e6).toFixed(1)} <UiMessage text={"MB"} />
								</span>
								<Button
									variant="outline"
									size="sm"
									disabled={disabled}
									onClick={() =>
										void action({
											action: "restore",
											snapshotId: snapshot.id,
											preserveExisting: true,
											metadataOnly,
										})
									}
								>
									<UiMessage text={"Open this version"} />
								</Button>
							</li>
						))}
					</ul>
				</div>
			) : null}
			{!legitateOnly && (
				<div className="space-y-3 border-t pt-4">
					<h3 className="font-medium">
						<UiMessage text={"Use this account on another machine"} />
					</h3>
					<p className="text-sm text-muted-foreground">
						<UiMessage
							text={
								"Download your password-protected recovery file. On the other machine, choose “Recover an account”, connect the same drive folder, and restore a saved version. Keep this file and its password: they unlock your encrypted storage."
							}
						/>
					</p>
					<label className="block text-sm">
						<UiMessage text={"Account password"} />
						<Input
							type="password"
							autoComplete="current-password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							className="mt-2"
						/>
					</label>
					<Button
						variant="outline"
						disabled={disabled || !password}
						onClick={() => void action({ action: "export-identity", password })}
					>
						<UiMessage text={"Download account recovery file"} />
					</Button>
				</div>
			)}
			{error && (
				<p role="alert" className="text-sm text-red-500">
					<UiValue>{error}</UiValue>
				</p>
			)}
		</section>
	);
}
