"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { importLegacyBrowserData } from "@/accounts/browser-import";
import { StorageSettings } from "@/accounts/storage-settings";
type State = {
	allowed: boolean;
	inventory: {
		projects: number;
		files: number;
		bytes: number;
		missing: { fileName: string; source: string }[];
	} | null;
	job: { status: string; files: number; total: number; error?: string } | null;
};
export default function AccountPage() {
	const [state, setState] = useState<State | null>(null),
		[error, setError] = useState("");
	const [browserImport, setBrowserImport] = useState(false),
		[browserProgress, setBrowserProgress] = useState("");
	async function refresh() {
		const response = await fetch("/api/accounts/migration", {
				cache: "no-store",
			}),
			result = await response.json();
		if (!response.ok) throw new Error(result.error);
		setState(result);
	}
	useEffect(() => {
		void refresh().catch((e) => setError(e.message));
	}, []);
	useEffect(() => {
		if (state?.job?.status !== "running") return;
		const timer = setInterval(
			() => void refresh().catch((e) => setError(e.message)),
			1500,
		);
		return () => clearInterval(timer);
	}, [state?.job?.status]);
	async function migrate(action: string) {
		setError("");
		try {
			const response = await fetch("/api/accounts/migration", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action }),
				}),
				result = await response.json();
			if (!response.ok) throw new Error(result.error);
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}
	async function logout() {
		const response = await fetch("/api/accounts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "logout" }),
		});
		if (response.ok) window.__opencutActivateAccount(null);
		else setError("Could not sign out. Try again.");
	}
	async function importBrowser() {
		setBrowserImport(true);
		setError("");
		try {
			await importLegacyBrowserData(setBrowserProgress);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBrowserImport(false);
		}
	}
	return (
		<main className="mx-auto max-w-3xl space-y-8 p-8">
			<header className="flex items-center justify-between">
				<h1 className="text-2xl font-semibold">Account & storage</h1>
				<Link className="underline" href="/projects">
					Projects
				</Link>
			</header>
			<section className="space-y-3 rounded-xl border p-6">
				<h2 className="text-lg font-medium">Storage on this machine</h2>
				<p className="text-sm text-muted-foreground">
					Your projects, media, and settings are stored in your account’s
					private workspace. New assets are saved outside Git.
				</p>
			</section>
			<StorageSettings />
			{state?.allowed && (
				<section className="space-y-4 rounded-xl border p-6">
					<h2 className="text-lg font-medium">Bring your existing work</h2>
					<p className="text-sm">
						Import copies and verifies your projects, assets, fonts, history,
						and settings into an empty workspace. Your original files stay
						intact.
					</p>
					{state.inventory && (
						<p>
							{state.inventory.projects} projects · {state.inventory.files}{" "}
							files · {(state.inventory.bytes / 1e9).toFixed(1)} GB
						</p>
					)}
					{!!state.inventory?.missing.length && (
						<div role="alert" className="text-sm text-amber-600">
							<p>Restore these linked files before importing:</p>
							<ul>
								{state.inventory.missing.map((file) => (
									<li key={file.source} className="break-all">
										{file.source}
									</li>
								))}
							</ul>
						</div>
					)}
					{state.job?.status === "running" ? (
						<>
							<p role="status">
								Verifying file {state.job.files} of {state.job.total}…
							</p>
							<button
								onClick={() => void migrate("cancel")}
								className="rounded border px-4 py-2"
							>
								Cancel import
							</button>
						</>
					) : (
						<button
							onClick={() => void migrate("import")}
							disabled={
								!state.inventory?.files ||
								!!state.inventory?.missing.length ||
								state.job?.status === "complete"
							}
							className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
						>
							{state.job?.status === "complete"
								? "Import verified"
								: "Import existing work"}
						</button>
					)}
					{state.job?.error && (
						<p role="alert" className="text-sm text-red-500">
							{state.job.error}
						</p>
					)}
					<div className="space-y-2 border-t pt-4">
						<p className="text-sm">
							If you also used this browser before accounts, copy its saved
							projects, media, and preferences. Run this after the drive import,
							in each browser you used.
						</p>
						<button
							disabled={
								browserImport ||
								state.job?.status === "running" ||
								(!!state.inventory?.files && state.job?.status !== "complete")
							}
							onClick={() => void importBrowser()}
							className="rounded border px-4 py-2"
						>
							Copy legacy browser data
						</button>
						{browserProgress && (
							<p role="status" className="text-sm">
								{browserProgress}
							</p>
						)}
					</div>
				</section>
			)}
			{error && (
				<p role="alert" className="text-red-500">
					{error}
				</p>
			)}
			<button
				onClick={() => void logout()}
				disabled={state?.job?.status === "running"}
				className="rounded border px-4 py-2"
			>
				Sign out
			</button>
		</main>
	);
}
