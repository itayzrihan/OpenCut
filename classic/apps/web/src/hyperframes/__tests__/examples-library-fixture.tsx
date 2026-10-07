import { createRoot } from "react-dom/client";
import { HyperframesExamplesLibrary } from "../examples-library";

export function mount(presentation: "dialog" | "page" = "dialog") {
	const root = createRoot(document.getElementById("examples")!);
	root.render(
		<HyperframesExamplesLibrary
			presentation={presentation}
			projectId="classic-project"
			onClose={() => root.unmount()}
		/>,
	);
}
