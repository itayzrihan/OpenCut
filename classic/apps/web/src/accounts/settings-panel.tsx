"use client";
import { LocalizedValue as UiValue } from "@/i18n/message";
import {
	LocalizedElement as UiLocalized,
	Message as UiMessage,
} from "@/i18n/message";
import { useEffect, useState } from "react";
import {
	ArchiveRestore,
	ArrowUpRight,
	HardDrive,
	Layers3,
	LogOut,
	UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkspaceLink } from "@/components/workspace-link";
import { importLegacyBrowserData } from "@/accounts/browser-import";
import { StorageSettings } from "@/accounts/storage-settings";
import { PasswordSettings } from "@/accounts/password-settings";
import { LanguageSettings } from "@/i18n/settings";
import { BRAND_KITS_HREF } from "@/brand-kits/types";
import { PeerSyncSettings } from "@/peer-sync/settings";
import { LegalLinks } from "@/legal/links";
import brand from "@/components/landing/pocut-brand.module.css";
import styles from "./settings.module.css";
import { useWorkspaceAccount } from "./gate";
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
export function AccountSettingsPanel() {
	const account = useWorkspaceAccount();
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
		<section
			aria-labelledby="workspace-account-heading"
			className="min-w-0 space-y-5 py-2"
		>
			<header className={styles.banner}>
				<div className={styles.heading}>
					<span className={styles.icon}>
						<UserRound size={19} aria-hidden="true" />
					</span>
					<h2
						id="workspace-account-heading"
						className="text-xl font-semibold tracking-tight"
					>
						<UiMessage text={"Account & storage"} />
					</h2>
				</div>
				{account?.displayName && (
					<bdi className={styles.identity}>{account.displayName}</bdi>
				)}
			</header>
			{error && (
				<p
					role="alert"
					className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
				>
					<UiValue>{error}</UiValue>
				</p>
			)}
			<div className={styles.columns}>
				<div className="min-w-0 space-y-4">
					<LanguageSettings />
					<StorageSettings legitateOnly={account?.legitateOnly ?? true} />
					<PeerSyncSettings />
					{state?.allowed && (
						<section className={styles.card}>
							<h3 className={styles.heading}>
								<ArchiveRestore
									className="size-4 text-primary"
									aria-hidden="true"
								/>
								<UiMessage text={"Bring your existing work"} />
							</h3>
							<p className="text-sm">
								<UiMessage
									text={
										"Import copies and verifies your projects, assets, fonts, history, and settings into an empty workspace. Your original files stay intact."
									}
								/>
							</p>
							{state.inventory && (
								<p>
									{state.inventory.projects} <UiMessage text={"projects ·"} />{" "}
									{state.inventory.files} <UiMessage text={"files ·"} />{" "}
									{(state.inventory.bytes / 1e9).toFixed(1)}{" "}
									<UiMessage text={"GB"} />
								</p>
							)}
							{!!state.inventory?.missing.length && (
								<div role="alert" className="text-sm text-amber-600">
									<p>
										<UiMessage
											text={
												"These sources are offline. Projects, edits and history will still import. Use Link missing files in the editor to reconnect them later:"
											}
										/>
									</p>
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
										<UiMessage text={"Verifying file"} /> {state.job.files}{" "}
										<UiMessage text={"of"} /> {state.job.total}…
									</p>
									<Button
										variant="outline"
										onClick={() => void migrate("cancel")}
									>
										<UiMessage text={"Cancel import"} />
									</Button>
								</>
							) : (
								<Button
									variant="outline"
									onClick={() => void migrate("import")}
									disabled={
										!state.inventory?.files || state.job?.status === "complete"
									}
									className={brand.primary}
								>
									{state.job?.status === "complete" ? (
										<UiMessage text={"Import verified"} />
									) : (
										<UiMessage text={"Import existing work"} />
									)}
								</Button>
							)}
							{state.job?.error && (
								<p role="alert" className="text-sm text-destructive">
									{state.job.error}
								</p>
							)}
							<div className="space-y-2 border-t pt-4">
								<p className="text-sm">
									<UiMessage
										text={
											"If you also used this browser before accounts, copy its saved projects, media, and preferences. Run this after the drive import, in each browser you used."
										}
									/>
								</p>
								<Button
									variant="outline"
									disabled={
										browserImport ||
										state.job?.status === "running" ||
										(!!state.inventory?.files &&
											state.job?.status !== "complete")
									}
									onClick={() => void importBrowser()}
								>
									<UiMessage text={"Copy legacy browser data"} />
								</Button>
								{browserProgress && (
									<p role="status" className="text-sm">
										{browserProgress}
									</p>
								)}
							</div>
						</section>
					)}
				</div>
				<aside className="min-w-0 space-y-4">
					<section className={styles.card}>
						<h3 className={styles.heading}>
							<HardDrive className="size-4 text-primary" aria-hidden="true" />
							<UiMessage text={"Storage on this machine"} />
						</h3>
						<p className="text-sm text-muted-foreground">
							<UiMessage
								text={
									"Your projects, media, and settings are stored in your account’s private workspace. New assets are saved outside Git."
								}
							/>
						</p>
					</section>
					<section className={styles.card}>
						<h3 className={styles.heading}>
							<Layers3 className="size-4 text-primary" aria-hidden="true" />{" "}
							<UiMessage text={"Brand Kits"} />
						</h3>
						<p className="text-sm text-muted-foreground">
							<UiMessage
								text={
									"Manage logos, palettes, typography and sounds for every client."
								}
							/>
						</p>
						<Button asChild variant="outline" className="w-fit">
							<WorkspaceLink
								href={BRAND_KITS_HREF}
								aria-disabled={account?.storageBusy}
							>
								<UiMessage text={"Manage Brand Kits"} />{" "}
								<ArrowUpRight size={14} aria-hidden="true" />
							</WorkspaceLink>
						</Button>
					</section>
					{account && !account.legitateOnly && <PasswordSettings />}
					<div className={styles.card}>
						<Button
							variant="outline"
							className="w-fit"
							onClick={() => void logout()}
							disabled={
								account?.storageBusy || state?.job?.status === "running"
							}
						>
							<LogOut size={16} aria-hidden="true" />{" "}
							<UiMessage text={"Sign out"} />
						</Button>
					</div>
					<UiLocalized<"nav">
						element="nav"
						messageProps={["aria-label"]}
						aria-label="Legal and accessibility"
						className="flex flex-wrap gap-x-4 gap-y-2 px-1 text-xs text-primary underline underline-offset-4"
					>
						<LegalLinks />
					</UiLocalized>
				</aside>
			</div>
		</section>
	);
}
