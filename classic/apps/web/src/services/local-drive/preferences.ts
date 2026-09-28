import { localDriveRequest } from "./client";

export function shouldPersistPreference(key: string): boolean {
	// Settings are forward-compatible. Device migration markers are not settings
	// and must never suppress a different machine's local data import.
	return !!key && key.length <= 256 && !key.startsWith("pocut-local-drive-") && !key.startsWith("legacy-");
}

export async function saveAllAccountPreferences() {
	for (let index = 0; index < localStorage.length; index++) {
		const key = localStorage.key(index);
		if (!key || !shouldPersistPreference(key)) continue;
		const value = localStorage.getItem(key);
		if (value !== null) await localDriveRequest({ operation: "preferences.put", payload: { key, value } });
	}
}

export async function hydrateAccountPreferences() {
	const preferences = await localDriveRequest<Record<string, string>>({ operation: "preferences.list" });
	let changed = false;
	for (const [key, value] of Object.entries(preferences)) if (shouldPersistPreference(key) && localStorage.getItem(key) !== value) { localStorage.setItem(key, value); changed = true; }
	return changed;
}

let isMirrorInstalled = false;

function installPreferenceMirror() {
	if (isMirrorInstalled) return;
	isMirrorInstalled = true;
	const originalSetItem = Storage.prototype.setItem;
	const originalRemoveItem = Storage.prototype.removeItem;

	// eslint-disable-next-line opencut/prefer-object-params -- Native Storage signature.
	Storage.prototype.setItem = function setItem(key: string, value: string) {
		originalSetItem.call(this, key, value);
		if (this === window.localStorage && shouldPersistPreference(key)) {
			void localDriveRequest({
				operation: "preferences.put",
				payload: { key, value },
			}).catch((error) =>
				console.error("Failed to save drive preference", error),
			);
		}
	};

	Storage.prototype.removeItem = function removeItem(key: string) {
		originalRemoveItem.call(this, key);
		if (this === window.localStorage && shouldPersistPreference(key)) {
			void localDriveRequest({
				operation: "preferences.delete",
				payload: { key },
			}).catch((error) =>
				console.error("Failed to delete drive preference", error),
			);
		}
	};
}

export async function synchronizeDrivePreferences(): Promise<boolean> {
	const drivePreferences = await localDriveRequest<Record<string, string>>({
		operation: "preferences.list",
	});
	const keys = Object.keys(drivePreferences);
	if (keys.length === 0) {
		for (let index = 0; index < localStorage.length; index++) {
			const key = localStorage.key(index);
			if (!key || !shouldPersistPreference(key)) continue;
			const value = localStorage.getItem(key);
			if (value === null) continue;
			await localDriveRequest({
				operation: "preferences.put",
				payload: { key, value },
			});
		}
		installPreferenceMirror();
		return false;
	}

	let changed = false;
	for (const [key, value] of Object.entries(drivePreferences)) {
		if (!shouldPersistPreference(key) || localStorage.getItem(key) === value)
			continue;
		localStorage.setItem(key, value);
		changed = true;
	}
	installPreferenceMirror();
	return changed;
}
