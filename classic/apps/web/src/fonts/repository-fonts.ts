export type RepositoryFontCopyResult = {
	sourceUrl: string;
	repositoryPath: string;
};

function isRepositoryFontCopyResult(
	value: unknown,
): value is RepositoryFontCopyResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"sourceUrl" in value &&
		"repositoryPath" in value &&
		typeof value.sourceUrl === "string" &&
		typeof value.repositoryPath === "string"
	);
}

export async function copyFontToRepository({
	projectId,
	fontId,
	file,
}: {
	projectId: string;
	fontId: string;
	file: File;
}): Promise<RepositoryFontCopyResult | null> {
	try {
		const formData = new FormData();
		formData.set("projectId", projectId);
		formData.set("fontId", fontId);
		formData.set("file", file);

		const response = await fetch("/api/project-fonts", {
			method: "POST",
			body: formData,
		});

		if (!response.ok) return null;

		const payload: unknown = await response.json();
		if (!isRepositoryFontCopyResult(payload)) {
			return null;
		}

		return {
			sourceUrl: payload.sourceUrl,
			repositoryPath: payload.repositoryPath,
		};
	} catch (error) {
		console.warn("Could not copy font into repository assets:", error);
		return null;
	}
}
