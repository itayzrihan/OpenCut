"use client";

import { LocalizedValue as UiValue } from "@/i18n/message";
import { Message as UiMessage } from "@/i18n/message";
import { useState, type FormEvent } from "react";
import styles from "@/components/landing/landing.module.css";
import { ACCOUNT_WORKSPACE_HREF } from "./workspace-route";

export function LocalSignIn({ returnTo }: { returnTo?: string }) {
	const [error, setError] = useState("");
	const [register, setRegister] = useState(false);
	const [recover, setRecover] = useState(false);
	const [busy, setBusy] = useState(false);
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
					throw new Error("Choose your POCUT account recovery JSON file");
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
				register || recover ? ACCOUNT_WORKSPACE_HREF : returnTo,
			);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not sign in");
			setBusy(false);
		}
	}
	return (
		<form onSubmit={submit} className={styles.localForm}>
			<div>
				<h2 className="text-base font-semibold">
					<UiMessage text={"Your local workspace"} />
				</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					<UiMessage
						text={
							"Projects, assets, and settings belong to your account. Your existing work stays preserved for import after setup."
						}
					/>
				</p>
			</div>
			{recover ? (
				<label className="block text-sm">
					<UiMessage text={"Account recovery file"} />
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
					<UiMessage text={"Account name"} />
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
					<UiMessage text={"Display name"} />
					<input
						required
						name="displayName"
						maxLength={128}
						className="mt-1 w-full rounded border bg-background p-2"
					/>
				</label>
			)}
			<label className="block text-sm">
				<UiMessage text={"Password"} />
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
					<UiValue>{error}</UiValue>
				</p>
			)}
			<button disabled={busy} className={styles.primary}>
				{busy ? (
					<UiMessage text={"Opening…"} />
				) : recover ? (
					<UiMessage text={"Recover account"} />
				) : register ? (
					<UiMessage text={"Create account"} />
				) : (
					<UiMessage text={"Sign in"} />
				)}
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
				{register || recover ? (
					<UiMessage text={"Use an existing account"} />
				) : (
					<UiMessage text={"Create a new account"} />
				)}
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
					<UiMessage text={"Recover an account on this machine"} />
				</button>
			)}
			<p className="text-xs text-muted-foreground">
				<UiMessage
					text={
						"This account is stored on this machine. Keep your password safe."
					}
				/>
			</p>
		</form>
	);
}
