import type { ReactNode } from "react";

// A worker must boot the current release, never a cached document pointing to
// JavaScript chunks removed by a local-production deployment.
export const dynamic = "force-dynamic";

export default function WorkerLayout({ children }: { children: ReactNode }) {
	console.info("[automation] Background worker document requested");
	return children;
}
