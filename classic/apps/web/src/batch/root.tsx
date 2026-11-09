"use client";
import dynamic from "next/dynamic";
import { WorkspaceLoading } from "@/components/workspace-loading";
import { useWorkspaceAccount } from "@/accounts/gate";
const BatchEditProvider = dynamic(
	() => import("./provider").then((m) => m.BatchEditProvider),
	{ ssr: false, loading: () => <WorkspaceLoading /> },
);
export function BatchEditRoot({ children }: { children: React.ReactNode }) {
	if (useWorkspaceAccount()?.storageBusy) return children;
	return <BatchEditProvider>{children}</BatchEditProvider>;
}
