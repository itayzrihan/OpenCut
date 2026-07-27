export async function createReplacementProjectIfMissing({
	projectExists,
	createProject,
}: {
	projectExists: boolean;
	createProject: () => Promise<string>;
}): Promise<string | null> {
	if (projectExists) return null;
	return createProject();
}
