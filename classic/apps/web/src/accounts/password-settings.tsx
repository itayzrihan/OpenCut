"use client";
import { useState } from "react";
export function PasswordSettings() {
	const [currentPassword, setCurrent] = useState("");
	const [password, setPassword] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<form
			className="space-y-3 rounded-xl border p-6"
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
			<h2 className="text-lg font-medium">Change temporary password</h2>
			<label className="block">
				Current password
				<input
					className="block w-full rounded border bg-background p-2"
					type="password"
					autoComplete="current-password"
					required
					value={currentPassword}
					onChange={(e) => setCurrent(e.target.value)}
				/>
			</label>
			<label className="block">
				New password (at least 12 characters)
				<input
					className="block w-full rounded border bg-background p-2"
					type="password"
					autoComplete="new-password"
					required
					minLength={12}
					value={password}
					onChange={(e) => setPassword(e.target.value)}
				/>
			</label>
			<button disabled={busy} className="rounded border px-3 py-2">
				Update password
			</button>
			{message && <p role="status">{message}</p>}
		</form>
	);
}
