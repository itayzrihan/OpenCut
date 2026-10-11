import { createRoot } from "react-dom/client";
import { TabBar } from "@/components/editor/panels/assets/tabbar";
import { CatalogView } from "@/components/editor/panels/assets/views/catalog";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HyperframesExamplesLibrary } from "../examples-library";

export function mount(presentation: "dialog" | "page" | "panel" = "dialog") {
	const root = createRoot(document.getElementById("examples")!);
	root.render(
		presentation === "panel" ? (
			<PanelFixture />
		) : (
			<HyperframesExamplesLibrary
				presentation={presentation}
				projectId="classic-project"
				onClose={() => root.unmount()}
			/>
		),
	);
}

/** Actual tab bar and catalog view, bounded to a narrow editor panel. */
function PanelFixture() {
	const { activeTab } = useAssetsPanelStore();
	return (
		<TooltipProvider>
			<div
				style={{ display: "flex", height: 700, width: 380 }}
				data-testid="assets-panel"
			>
				<TabBar />
				<div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
					{activeTab === "catalog" ? (
						<CatalogView />
					) : (
						<p>Selected tab: {activeTab}</p>
					)}
				</div>
			</div>
		</TooltipProvider>
	);
}
