import type {
	PreviewOverlayDefinition,
	PreviewOverlaySourceResult,
} from "@/preview/overlays";

export const safeAreaPreviewOverlay: PreviewOverlayDefinition = {
	id: "safe-area",
	label: "Safe area",
	defaultVisible: false,
};

export function getSafeAreaPreviewOverlaySource({
	isVisible,
}: {
	isVisible: boolean;
}): PreviewOverlaySourceResult {
	return {
		definitions: [safeAreaPreviewOverlay],
		instances: isVisible
			? [
					{
						id: safeAreaPreviewOverlay.id,
						mount: { kind: "scene" },
						plane: "under-interaction",
						pointerEvents: "none",
						zIndex: 10,
						render: () => <SafeAreaOverlay />,
					},
				]
			: [],
	};
}

function SafeAreaOverlay() {
	return (
		<div className="absolute inset-0">
			<div
				className="absolute"
				style={{
					inset: "5%",
					border: "1px solid rgba(255, 255, 255, 0.7)",
					boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.35)",
				}}
			/>
			<div
				className="absolute"
				style={{
					inset: "10%",
					border: "1px dashed rgba(255, 255, 255, 0.75)",
					boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.35)",
				}}
			/>
		</div>
	);
}
