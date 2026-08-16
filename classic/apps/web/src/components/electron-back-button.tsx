"use client";

import { useEffect, useState } from "react";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";

/**
 * Shows a back button when user is stranded on an external OAuth error page in Electron.
 * Only renders if running in Electron and there's navigation history.
 */
export function ElectronBackButton() {
	const [canGoBack, setCanGoBack] = useState(false);
	const [isElectron, setIsElectron] = useState(false);

	useEffect(() => {
		// Check if running in Electron
		const electronBridge = (typeof window !== "undefined" &&
			(window as any).opencutElectron) as
			| { canGoBack?: () => Promise<boolean> }
			| undefined;

		if (!electronBridge?.canGoBack) {
			setIsElectron(false);
			return;
		}

		setIsElectron(true);

		// Check if we can go back
		electronBridge.canGoBack().then((can) => {
			setCanGoBack(can);
		});

		// Listen for URL changes to update back button availability
		const handlePopState = async () => {
			const can = await electronBridge.canGoBack?.();
			setCanGoBack(can ?? false);
		};

		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, []);

	if (!isElectron || !canGoBack) {
		return null;
	}

	const handleGoBack = async () => {
		const electronBridge = (window as any).opencutElectron;
		if (electronBridge?.goBack) {
			await electronBridge.goBack();
		}
	};

	return (
		<div className="fixed top-4 left-4 z-50">
			<Button
				onClick={handleGoBack}
				variant="outline"
				size="sm"
				title="Go back to OpenCut"
				className="gap-2"
			>
				<HugeiconsIcon icon={ArrowLeft01Icon} className="h-4 w-4" />
				Back
			</Button>
		</div>
	);
}
