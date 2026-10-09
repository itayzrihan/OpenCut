import { redirect } from "next/navigation";

/** The editor owns the session and chat while the examples page is displayed. */
export default async function ExamplesPage({
	params,
}: {
	params: Promise<{ project_id: string }>;
}) {
	const { project_id } = await params;
	redirect(`/editor/${encodeURIComponent(project_id)}?view=examples`);
}
