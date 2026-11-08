/** Synchronous shutdown hooks for authenticated host services, including logout.
 * Registration is process-local; it grants no identity or project authority. */
type Listener = (accountId: string) => void;
const host = globalThis as typeof globalThis & {
	__opencutAccountDisconnect?: Map<string, Listener>;
};
const listeners = (host.__opencutAccountDisconnect ??= new Map<
	string,
	Listener
>());
export function onAccountDisconnect({
	name,
	listener,
}: {
	name: string;
	listener: Listener;
}) {
	listeners.set(name, listener);
	return () => {
		if (listeners.get(name) === listener) listeners.delete(name);
	};
}
export function notifyAccountDisconnect(accountId: string) {
	for (const listener of listeners.values()) {
		try {
			listener(accountId);
		} catch {
			/* A failed service cannot prevent logout. */
		}
	}
}
