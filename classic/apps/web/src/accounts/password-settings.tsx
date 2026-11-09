"use client";
import { Message as UiMessage } from "@/i18n/message";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import brand from "@/components/landing/pocut-brand.module.css";
import styles from "./settings.module.css";
export function PasswordSettings() {
	const [currentPassword, setCurrent] = useState("");
	const [password, setPassword] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<form
			className={styles.card}
			onSubmit={async (event) => {
				event.preventDefault();
				setBusy(true);
				setMessage("");
				try {
					const response = await fetch("/api/accounts", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							action: "change-password",
							currentPassword,
							password,
						}),
					});
					const result = await response.json();
					if (!response.ok) throw new Error(result.error);
					setCurrent("");
					setPassword("");
					setMessage(
						"Password updated. Other sessions on this machine were signed out.",
					);
				} catch (error) {
					setMessage(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(false);
				}
			}}
		>
			<h3 className={styles.heading}>
				<ShieldCheck className="size-4 text-primary" aria-hidden="true" />
				<UiMessage text={"Change temporary password"} />
			</h3>
			<label className="grid gap-2 text-sm">
				<UiMessage text={"Current password"} />
				<Input
					type="password"
					autoComplete="current-password"
					required
					value={currentPassword}
					onChange={(e) => setCurrent(e.target.value)}
				/>
			</label>
			<label className="grid gap-2 text-sm">
				<UiMessage text={"New password (at least 12 characters)"} />
				<Input
					type="password"
					autoComplete="new-password"
					required
					minLength={12}
					value={password}
					onChange={(e) => setPassword(e.target.value)}
				/>
			</label>
			<Button
				type="submit"
				disabled={busy}
				className={`${brand.primary} w-fit`}
			>
				<UiMessage text={"Update password"} />
			</Button>
			{message && (
				<p role="status" className="text-sm text-muted-foreground">
					<UiMessage text={message} />
				</p>
			)}
		</form>
	);
}
