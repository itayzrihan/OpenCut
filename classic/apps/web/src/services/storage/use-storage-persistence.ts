"use client";

import { useEffect, useState } from "react";

const DISMISSED_KEY = "opencut-storage-persist-warning-dismissed-v2";

export type StoragePersistenceDialogReason = "request" | "denied" | "error";

type PersistenceStorage = Pick<StorageManager, "persist" | "persisted">;

export async function resolveInitialPersistenceReason({
	storage,
	browserIsFirefox,
}: {
	storage: Partial<PersistenceStorage> | undefined;
	browserIsFirefox: boolean;
}): Promise<StoragePersistenceDialogReason | null> {
	if (!storage?.persist || !storage.persisted) return "error";

	try {
		if (await storage.persisted()) return null;
	} catch {
		return "error";
	}

	if (browserIsFirefox) return "request";

	try {
		return (await storage.persist()) ? null : "denied";
	} catch {
		return "error";
	}
}

export async function requestStoragePersistence(
	storage: Partial<PersistenceStorage> | undefined,
): Promise<Exclude<StoragePersistenceDialogReason, "request"> | null> {
	if (!storage?.persist) return "error";

	try {
		return (await storage.persist()) ? null : "denied";
	} catch {
		return "error";
	}
}

function isFirefox(): boolean {
	return navigator.userAgent.toLowerCase().includes("firefox");
}

function wasDismissed(): boolean {
	try {
		return localStorage.getItem(DISMISSED_KEY) === "true";
	} catch {
		return false;
	}
}

function rememberDismissal(): void {
	try {
		localStorage.setItem(DISMISSED_KEY, "true");
	} catch {
		// Storage may be unavailable in private or restricted browsing modes.
	}
}

export function useStoragePersistence() {
	const [showDialog, setShowDialog] = useState(false);
	const [reason, setReason] =
		useState<StoragePersistenceDialogReason>("request");
	const [isRequesting, setIsRequesting] = useState(false);

	useEffect(() => {
		let isMounted = true;

		const run = async () => {
			if (wasDismissed()) return;

			const promptReason = await resolveInitialPersistenceReason({
				storage: navigator.storage,
				browserIsFirefox: isFirefox(),
			});
			if (!isMounted || promptReason === null) return;

			setReason(promptReason);
			setShowDialog(true);
		};

		void run();

		return () => {
			isMounted = false;
		};
	}, []);

	const onConfirm = async () => {
		setIsRequesting(true);
		try {
			const nextReason = await requestStoragePersistence(navigator.storage);
			if (nextReason === null) {
				setShowDialog(false);
				return;
			}

			setReason(nextReason);
			setShowDialog(true);
		} finally {
			setIsRequesting(false);
		}
	};

	const onDismiss = () => {
		if (isRequesting) return;
		setShowDialog(false);
		rememberDismissal();
	};

	return { showDialog, reason, isRequesting, onConfirm, onDismiss };
}
