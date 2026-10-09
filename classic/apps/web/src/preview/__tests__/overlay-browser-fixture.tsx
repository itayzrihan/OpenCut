import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { PreviewPanelWithOverlays } from "../components/panel-with-overlays";

flushSync(() =>
	createRoot(document.getElementById("root")!).render(
		<PreviewPanelWithOverlays />,
	),
);
