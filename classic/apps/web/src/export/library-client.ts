import { accountAssetUrl } from "@/accounts/browser";
import type { SavedExportInfo } from "./library-server";
export async function projectExportRequest<T = SavedExportInfo>(
	body: unknown,
): Promise<T> {
	const response = await fetch(accountAssetUrl("/api/project-export"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const result = await response.json();
	if (!response.ok) throw Error(result.error ?? "Project export failed");
	return result;
}
