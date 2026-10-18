"use client";
import dynamic from "next/dynamic";
import { WorkspaceLoading } from "@/components/workspace-loading";
const BatchEditProvider = dynamic(
	() => import("./provider").then((m) => m.BatchEditProvider),
	{ ssr: false, loading: () => <WorkspaceLoading /> },
);
export function BatchEditRoot({ children }: { children: React.ReactNode }) {
	return <BatchEditProvider>{children}</BatchEditProvider>;
}
