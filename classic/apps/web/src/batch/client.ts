import { batchWriteHeaders } from "./write-token";
import type { BatchState } from "./types";
export async function batchRequest<T = BatchState>(body?: unknown): Promise<T> {
	const response = await fetch(
		"/api/batch-edit",
		body
			? {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...batchWriteHeaders(),
					},
					body: JSON.stringify(body),
				}
			: { cache: "no-store" },
	);
	const result = await response.json();
	if (!response.ok) throw new Error(result.error ?? "Batch request failed");
	return result;
}
