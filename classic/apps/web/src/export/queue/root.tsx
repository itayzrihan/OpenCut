"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AccountGate } from "@/accounts/gate";
import { BatchEditRoot } from "@/batch/root";
const View = dynamic(() => import("./view"), { ssr: false });
export function RenderQueueRoot({ children }: { children: React.ReactNode }) {
	const [open, setOpen] = useState(false);
	const path = usePathname();
	useEffect(() => {
		const show = () => setOpen(true);
		window.addEventListener("opencut:open-render-queue", show);
		return () => window.removeEventListener("opencut:open-render-queue", show);
	}, []);
	// The isolated host worker authenticates only its bounded renderer APIs.
	// It must not hydrate account preferences, batch tasks or editable projects.
	if (path === "/render-worker") return children;
	return (
		<AccountGate>
			<BatchEditRoot>
				{children}
				<Dialog open={open} onOpenChange={setOpen}>
					<DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
						<DialogTitle className="sr-only">Render Queue</DialogTitle>
						{open && <View />}
					</DialogContent>
				</Dialog>
			</BatchEditRoot>
		</AccountGate>
	);
}
