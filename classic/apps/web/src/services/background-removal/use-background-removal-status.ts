"use client";

import { useSyncExternalStore } from "react";
import { backgroundRemovalService } from "./service";

export function useBackgroundRemovalStatus() {
	return useSyncExternalStore(
		backgroundRemovalService.subscribe,
		backgroundRemovalService.getStatus,
		backgroundRemovalService.getStatus,
	);
}
