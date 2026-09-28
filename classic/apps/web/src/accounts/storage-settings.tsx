"use client";
import { useEffect, useState } from "react";
import { saveAllAccountPreferences } from "@/services/local-drive/preferences";
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
export function StorageSettings() {
	const [state, setState] = useState<State | null>(null),
		[folder, setFolder] = useState(""),
		[password, setPassword] = useState("");
	const [error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	const [automatic, setAutomatic] = useState(false);
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
				anchor.download = "OpenCut-account-recovery.json";
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
		<section className="space-y-5 rounded-xl border p-6">
			<div>
				<h2 className="text-lg font-medium">Your storage</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					Keep work local, or save encrypted versions to an external drive, a
					drive provider’s synced folder, or a mounted folder shared by one of
					your machines. OpenCut keeps a separate account vault outside Git.
				</p>
			</div>
			<fieldset className="space-y-2" disabled={disabled}>
				<legend className="mb-2 text-sm font-medium">
					Where to keep saved versions
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
							className={`cursor-pointer rounded border p-3 text-sm ${mode === value ? "border-primary bg-primary/5" : ""}`}
						>
							<span className="flex items-center gap-2 font-medium">
								<input
									type="radio"
									name="storage-mode"
									value={value}
									checked={mode === value}
									onChange={() => setMode(value)}
								/>
								{label}
							</span>
							<span className="mt-2 block text-xs text-muted-foreground">
								{description}
							</span>
						</label>
					))}
				</div>
			</fieldset>
			{mode !== "localOnly" && (
				<>
					{mode === "personalDevices" && (
						<p className="text-sm text-muted-foreground">
							Choose a folder on this machine, or a mounted share from another
							machine you own. To connect another computer, recover this account
							there and select the same shared folder. The machine hosting the
							share must be reachable when saving or opening versions.
						</p>
					)}
					<label className="block space-y-1 text-sm">
						<span>
							{mode === "personalDevices"
								? "Shared folder on your machine"
								: "Existing storage folder"}
						</span>
						<input
							value={folder}
							onChange={(event) => setFolder(event.target.value)}
							placeholder="Full path to your drive or mounted share"
							className="w-full rounded border bg-background p-2"
							disabled={disabled}
						/>
					</label>
					<label className="block space-y-1 text-sm">
						<span>Name for this machine</span>
						<input
							value={deviceName}
							onChange={(event) => setDeviceName(event.target.value)}
							maxLength={128}
							disabled={disabled}
							className="w-full rounded border bg-background p-2"
						/>
					</label>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={automatic}
							onChange={(event) => setAutomatic(event.target.checked)}
							disabled={disabled}
						/>
						Automatically save changed work every five minutes while OpenCut is
						open
					</label>
				</>
			)}
			<div className="flex flex-wrap gap-2">
				<button
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
					className="rounded border px-4 py-2 disabled:opacity-50"
				>
					Save storage choice
				</button>
				{state?.profile.folder && (
					<button
						disabled={disabled || state.connection.status !== "connected"}
						onClick={() => void action({ action: "publish" })}
						className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
					>
						Save encrypted snapshot
					</button>
				)}
			</div>
			<p className="text-sm">
				{state?.connection.status === "unavailable"
					? `Destination unavailable: ${state.profile.folder}. Your local workspace remains available.`
					: state?.profile.folder
						? `Connected: ${state.profile.folder}`
						: "Local only. Your work stays on this machine."}
			</p>
			{state?.connection.error && (
				<p role="status" className="break-words text-sm text-amber-600">
					{state.connection.error}
				</p>
			)}
			<button
				disabled={disabled}
				onClick={() => void refresh().catch((error) => setError(error.message))}
				className="text-sm underline disabled:opacity-50"
			>
				Refresh connection and versions
			</button>
			{!!state?.devices.length && (
				<div className="space-y-2">
					<h3 className="font-medium">Machines using this vault</h3>
					<p className="text-xs text-muted-foreground">
						These identities were verified from the shared vault. The last
						connection or save does not indicate whether a machine is online
						now.
					</p>
					<ul className="space-y-2">
						{state.devices.map((device) => (
							<li key={device.id} className="rounded border p-3 text-sm">
								<p className="font-medium">
									{device.name}
									{device.id === state.currentDevice.id
										? " (this machine)"
										: ""}
								</p>
								<p className="text-xs text-muted-foreground">
									Last connection or save:{" "}
									{new Date(device.lastSeenAt).toLocaleString()}
								</p>
								<details className="mt-1 text-xs">
									<summary className="cursor-pointer">
										Device fingerprint
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
						{state.job?.action === "restore"
							? "Restoring"
							: "Encrypting and verifying"}
						: {state.job?.files} / {state.job?.total || "…"} files
					</p>
					<button
						onClick={() => void action({ action: "cancel" })}
						className="underline"
					>
						Cancel
					</button>
				</div>
			)}
			{state?.job && !running && (
				<p role="status" className="text-sm">
					{state.job.status === "complete"
						? "Operation completed and verified."
						: (state.job.error ?? state.job.status)}
				</p>
			)}
			{state?.snapshots.length ? (
				<div className="space-y-3">
					<h3 className="font-medium">Saved versions</h3>
					<p className="text-xs text-muted-foreground">
						Versions from every connected machine remain separate. Opening a
						version first saves your current work as an encrypted version and
						retains its local files.
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
										)?.name ?? `Machine ${snapshot.deviceId.slice(0, 8)}`}
										{snapshot.deviceId === state.currentDevice.id
											? " (this machine)"
											: ""}
									</span>
									{new Date(snapshot.createdAt).toLocaleString()} ·{" "}
									{snapshot.files} files · {(snapshot.bytes / 1e6).toFixed(1)}{" "}
									MB
								</span>
								<button
									disabled={disabled}
									onClick={() =>
										void action({
											action: "restore",
											snapshotId: snapshot.id,
											preserveExisting: true,
										})
									}
									className="underline disabled:opacity-50"
								>
									Open this version
								</button>
							</li>
						))}
					</ul>
				</div>
			) : null}
			<div className="space-y-3 border-t pt-4">
				<h3 className="font-medium">Use this account on another machine</h3>
				<p className="text-sm text-muted-foreground">
					Download your password-protected recovery file. On the other machine,
					choose “Recover an account”, connect the same drive folder, and
					restore a saved version. Keep this file and its password: they unlock
					your encrypted storage.
				</p>
				<label className="block text-sm">
					Account password
					<input
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						className="mt-1 w-full rounded border bg-background p-2"
					/>
				</label>
				<button
					disabled={disabled || !password}
					onClick={() => void action({ action: "export-identity", password })}
					className="rounded border px-4 py-2 disabled:opacity-50"
				>
					Download account recovery file
				</button>
			</div>
			{error && (
				<p role="alert" className="text-sm text-red-500">
					{error}
				</p>
			)}
		</section>
	);
}
