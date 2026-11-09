"use client";

import {
	LocalizedElement as UiLocalized,
	Message as UiMessage,
} from "@/i18n/message";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";

export function ElectronBackButton() {
	const pathname = usePathname();
	const [canGoBack, setCanGoBack] = useState(false);

	useEffect(() => {
		const bridge = window.opencutElectron;
		if (!bridge?.canGoBack) return;

		let active = true;
		const syncHistory = () => {
			void bridge
				.canGoBack?.()
				.then((available) => {
					if (active) setCanGoBack(available);
				})
				.catch(() => {
					if (active) setCanGoBack(false);
				});
		};

		syncHistory();
		window.addEventListener("popstate", syncHistory);
		return () => {
			active = false;
			window.removeEventListener("popstate", syncHistory);
		};
	}, [pathname]);

	if (!canGoBack) return null;

	return (
		<UiLocalized<typeof Button>
			element={Button}
			messageProps={["aria-label", "title"]}
			data-pocut-electron-back
			onClick={() => void window.opencutElectron?.goBack?.()}
			variant="outline"
			size="sm"
			aria-label="Back"
			title="Go back"
			className="shrink-0 gap-1.5"
		>
			<HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" />
			<UiMessage text={"Back"} />
		</UiLocalized>
	);
}
