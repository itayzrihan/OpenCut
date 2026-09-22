/** Only the isolated worker realm holds a write lease. Never persisted in project state. */
let token = "";
export function setBatchWriteToken(value: string) {
	token = value;
}
export function batchWriteHeaders(): Record<string, string> {
	return token ? { "X-OpenCut-Batch-Token": token } : {};
}
