"use client";

import { useEditorProject } from "@/editor/use-editor";
import { HyperframesExamplesLibrary } from "@/hyperframes/examples-library";
import { useAssetsPanelStore } from "../assets-panel-store";

export function CatalogView() {
	const projectId = useEditorProject(
		(editor) => editor.project.getActive().metadata.id,
	);
	return (
		<HyperframesExamplesLibrary
			key={projectId}
			projectId={projectId}
			presentation="panel"
			onClose={() => useAssetsPanelStore.getState().setActiveTab("media")}
		/>
	);
}
