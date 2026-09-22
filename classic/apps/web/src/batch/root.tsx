"use client";
import dynamic from "next/dynamic";
const BatchEditProvider = dynamic(
	() => import("./provider").then((m) => m.BatchEditProvider),
	{ ssr: false },
);
export function BatchEditRoot({ children }: { children: React.ReactNode }) {
	return <BatchEditProvider>{children}</BatchEditProvider>;
}
