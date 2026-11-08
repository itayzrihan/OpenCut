import type { Server } from "node:http";
export type RelayIdentity = { owner: string; expiresAt: number };
export function verifyRelayIdentity(
	token: string,
	key?: unknown,
): Promise<RelayIdentity>;
export function createPeerRelay(options?: {
	verifyIdentity?: (token: string) => Promise<RelayIdentity>;
	now?: () => number;
}): Server;
