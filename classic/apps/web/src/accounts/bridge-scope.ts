export function scopedBridgeSession({
	accountId,
	sessionId,
}: {
	accountId: string;
	sessionId: unknown;
}) {
	if (
		typeof sessionId !== "string" ||
		!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)
	)
		throw new Error("Invalid browser session");
	return `${accountId}_${sessionId}`;
}
export function accountBridgeCommand({
	accountId,
	value,
}: {
	accountId: string;
	value: unknown;
}): Record<string, unknown> & { sessionId: string } {
	if (
		!value ||
		typeof value !== "object" ||
		!("sessionId" in value) ||
		typeof value.sessionId !== "string" ||
		!value.sessionId.startsWith(`${accountId}_`)
	)
		throw new Error("Bridge returned a command for another account");
	return { ...value, sessionId: value.sessionId.slice(accountId.length + 1) };
}
