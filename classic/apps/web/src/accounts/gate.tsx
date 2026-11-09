"use client";
import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import {
	createContext,
	useContext,
	useEffect,
	useState,
	type ReactNode,
} from "react";
import { hydrateAccountPreferences } from "@/services/local-drive/preferences";
import { BackgroundSnapshots } from "./background-snapshots";
import { WorkspaceLoading } from "@/components/workspace-loading";
import { PeerSyncPresence } from "@/peer-sync/presence";
import { usePathname } from "next/navigation";
import { PocutLanding } from "@/components/landing/pocut-landing";
import { BRAND_KITS_HREF } from "@/brand-kits/types";
import { ACCOUNT_WORKSPACE_HREF, isAccountWorkspace } from "./workspace-route";
type Account = { id: string; displayName: string };
const WorkspaceAccount = createContext<{
	displayName: string;
	canConnectLegitate: boolean;
	legitateOnly: boolean;
	hostedLegitate: boolean;
	storageBusy: boolean;
} | null>(null);

export function useWorkspaceAccount() {
	return useContext(WorkspaceAccount);
}

export function AccountGate({ children }: { children: ReactNode }) {
	const path = usePathname();
	const [account, setAccount] = useState<Account | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [legitateConfigured, setLegitateConfigured] = useState(false);
	const [legitateOnly, setLegitateOnly] = useState(false);
	const [hostedLegitate, setHostedLegitate] = useState(false);
	const [storageBusy, setStorageBusy] = useState(false);
	useEffect(() => {
		let cancelled = false;
		fetch("/api/accounts", { cache: "no-store" })
			.then((r) => r.json())
			.then(
				async ({
					account: current,
					storageBusy,
					legitateConfigured: configured,
					legitateOnly: only,
					hostedLegitate: hosted,
				}) => {
					if (cancelled) return;
					setLegitateConfigured(!!configured);
					setLegitateOnly(!!only);
					setHostedLegitate(!!hosted);
					window.__opencutHostedLegitate = hosted === true;
					if ((current?.id ?? null) !== window.__opencutAccountId) {
						console.info("[workspace] Reloading after account change");
						window.__opencutActivateAccount(current?.id ?? null);
						return;
					}
					setAccount(current);
					if (current && storageBusy) {
						if (!isAccountWorkspace(window.location)) {
							window.location.replace(ACCOUNT_WORKSPACE_HREF);
							return;
						}
						setStorageBusy(true);
						setLoading(false);
						return;
					}
					const preferencesChanged =
						current && (await hydrateAccountPreferences());
					if (cancelled) return;
					if (preferencesChanged) {
						console.info("[workspace] Reloading after preference hydration");
						window.location.reload();
						return;
					}
					setAccount(current);
					setLoading(false);
				},
			)
			.catch(() => {
				if (cancelled) return;
				setError("Could not connect to account storage. Try reloading.");
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);
	useEffect(() => {
		if (!storageBusy || !account) return;
		const controller = new AbortController();
		const timer = setInterval(() => {
			void fetch("/api/accounts", {
				cache: "no-store",
				signal: controller.signal,
			})
				.then((response) => response.json())
				.then((current) => {
					if (
						!controller.signal.aborted &&
						current.account?.id === account.id &&
						current.storageBusy === false
					)
						window.location.reload();
				})
				.catch(() => {});
		}, 2500);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [account, storageBusy]);
	if (loading) return <WorkspaceLoading />;
	if (account && error)
		return (
			<main className="grid min-h-screen place-items-center p-8">
				<div className="space-y-4">
					<p role="alert">
						<UiMessage
							text={
								"Your workspace settings could not be loaded. If an import or sync is running, wait for it to finish."
							}
						/>
					</p>
					<button
						className="rounded border px-4 py-2"
						onClick={() => window.location.reload()}
					>
						<UiMessage text={"Retry opening workspace"} />
					</button>
				</div>
			</main>
		);
	if (account)
		return (
			<WorkspaceAccount.Provider
				value={{
					displayName: account.displayName,
					canConnectLegitate: legitateConfigured && !legitateOnly,
					legitateOnly,
					hostedLegitate,
					storageBusy,
				}}
			>
				{!hostedLegitate && <BackgroundSnapshots />}
				{!hostedLegitate && <PeerSyncPresence />}
				{children}
				{path !== "/projects" && (
					<UiLocalized<"nav">
						element={"nav"}
						messageProps={["aria-label"]}
						aria-label="Workspace"
						className="fixed bottom-3 left-3 z-50 flex max-w-[calc(100vw-1.5rem)] items-center gap-2"
					>
						<UiLocalized<"a">
							element={"a"}
							messageProps={["aria-label"]}
							href={ACCOUNT_WORKSPACE_HREF}
							className="max-w-48 truncate rounded border bg-background px-3 py-1 text-xs shadow"
							aria-label="Account and storage settings"
						>
							{account.displayName}
						</UiLocalized>
						<a
							href={BRAND_KITS_HREF}
							className="shrink-0 rounded border bg-background px-3 py-1 text-xs shadow"
						>
							<UiMessage text={"Brand Kits"} />
						</a>
						{legitateConfigured && !legitateOnly && (
							<form action="/api/accounts/legitate/start" method="post">
								<button className="rounded border bg-background px-3 py-1 text-xs shadow">
									<UiMessage text={"Connect Legitate"} />
								</button>
							</form>
						)}
					</UiLocalized>
				)}
			</WorkspaceAccount.Provider>
		);
	return (
		<PocutLanding
			legitateConfigured={legitateConfigured}
			legitateOnly={legitateOnly}
			error={error}
		/>
	);
}
