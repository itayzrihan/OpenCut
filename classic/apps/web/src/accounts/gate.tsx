"use client";
import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import { hydrateAccountPreferences } from "@/services/local-drive/preferences";
import { BackgroundSnapshots } from "./background-snapshots";
type Account = { id: string; displayName: string };
export function AccountGate({ children }: { children: ReactNode }) {
	const [account, setAccount] = useState<Account | null>(null);
	const [loading, setLoading] = useState(true);
	const [register, setRegister] = useState(false);
	const [recover, setRecover] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		fetch("/api/accounts", { cache: "no-store" })
			.then((r) => r.json())
			.then(async ({ account: current, storageBusy }) => {
				if ((current?.id ?? null) !== window.__opencutAccountId) {
					window.__opencutActivateAccount(current?.id ?? null);
					return;
				}
				setAccount(current);
				if (current && storageBusy) {
					if (window.location.pathname !== "/account") {
						window.location.replace("/account");
						return;
					}
					setLoading(false);
					return;
				}
				if (current && (await hydrateAccountPreferences())) {
					window.location.reload();
					return;
				}
				setAccount(current);
				setLoading(false);
			})
			.catch(() => {
				setError("Could not connect to account storage. Try reloading.");
				setLoading(false);
			});
	}, []);
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setBusy(true);
		setError("");
		const form = new FormData(event.currentTarget);
		try {
			let recovery: unknown;
			if (recover) {
				const file = form.get("recovery");
				if (!(file instanceof File) || !file.size || file.size > 16 * 1024)
					throw new Error("Choose your OpenCut account recovery JSON file");
				recovery = JSON.parse(await file.text());
			}
			const response = await fetch("/api/accounts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: recover ? "recover" : register ? "register" : "login",
					login: form.get("login"),
					displayName: form.get("displayName"),
					password: form.get("password"),
					recovery,
				}),
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error);
			window.__opencutActivateAccount(
				result.account.id,
				register || recover ? "/account" : undefined,
			);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not sign in");
			setBusy(false);
		}
	}
	if (loading)
		return (
			<main className="grid min-h-screen place-items-center">
				Opening your workspace…
			</main>
		);
	if (account && error)
		return (
			<main className="grid min-h-screen place-items-center p-8">
				<div className="space-y-4">
					<p role="alert">
						Your workspace settings could not be loaded. If an import or sync is
						running, wait for it to finish.
					</p>
					<button
						className="rounded border px-4 py-2"
						onClick={() => window.location.reload()}
					>
						Retry opening workspace
					</button>
				</div>
			</main>
		);
	if (account)
		return (
			<>
				<BackgroundSnapshots />
				{children}
				<a
					href="/account"
					className="fixed bottom-3 left-3 z-50 rounded border bg-background px-3 py-1 text-xs shadow"
					aria-label="Account and storage settings"
				>
					{account.displayName}
				</a>
			</>
		);
	return (
		<main className="grid min-h-screen place-items-center p-6">
			<form
				onSubmit={submit}
				className="w-full max-w-md space-y-5 rounded-xl border p-8"
			>
				<div>
					<h1 className="text-2xl font-semibold">Your OpenCut workspace</h1>
					<p className="mt-2 text-sm text-muted-foreground">
						Projects, assets, and settings belong to your account. Your existing
						work stays preserved for import after setup.
					</p>
				</div>
				{recover ? (
					<label className="block text-sm">
						Account recovery file
						<input
							required
							type="file"
							accept=".json,application/json"
							name="recovery"
							className="mt-1 w-full rounded border p-2"
						/>
					</label>
				) : (
					<label className="block text-sm">
						Account name
						<input
							required
							name="login"
							autoComplete="username"
							minLength={3}
							maxLength={128}
							className="mt-1 w-full rounded border bg-background p-2"
						/>
					</label>
				)}
				{register && !recover && (
					<label className="block text-sm">
						Display name
						<input
							required
							name="displayName"
							maxLength={128}
							className="mt-1 w-full rounded border bg-background p-2"
						/>
					</label>
				)}
				<label className="block text-sm">
					Password
					<input
						required
						name="password"
						type="password"
						autoComplete={register ? "new-password" : "current-password"}
						minLength={register ? 12 : 1}
						maxLength={1024}
						className="mt-1 w-full rounded border bg-background p-2"
					/>
				</label>
				{error && (
					<p role="alert" className="text-sm text-red-500">
						{error}
					</p>
				)}
				<button
					disabled={busy}
					className="w-full rounded bg-primary p-2 text-primary-foreground disabled:opacity-50"
				>
					{busy
						? "Opening…"
						: recover
							? "Recover account"
							: register
								? "Create account"
								: "Sign in"}
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => {
						setRegister(recover ? false : !register);
						setRecover(false);
					}}
					className="w-full text-sm underline"
				>
					{register || recover
						? "Use an existing account"
						: "Create a new account"}
				</button>
				{!recover && (
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							setRegister(false);
							setRecover(true);
						}}
						className="w-full text-sm underline"
					>
						Recover an account on this machine
					</button>
				)}
				<p className="text-xs text-muted-foreground">
					This account is stored on this machine. Keep your password safe.
				</p>
			</form>
		</main>
	);
}
