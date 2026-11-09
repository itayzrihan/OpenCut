import {
	LocalizedElement as UiLocalized,
	Message as UiMessage,
} from "@/i18n/message";
import type { CSSProperties, ReactNode } from "react";
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

// Classic-only preview decoration. Reuses the existing overlay visibility action;
// no project state, renderer layer or exported pixels are added.
// These are composition guides, not platform-specific visibility guarantees.
const SUPER_SAFE_TOP = "22%";
const SUPER_SAFE_BOTTOM = "74%";

function GuideLabel({
	children,
	style,
	accent = false,
}: {
	children: ReactNode;
	style: CSSProperties;
	accent?: boolean;
}) {
	return (
		<div
			dir="rtl"
			className="absolute rounded px-1.5 py-0.5 text-center leading-tight"
			style={{
				color: accent ? "#fcd34d" : "#f1f5f9",
				background: "rgba(15, 23, 42, 0.82)",
				fontSize: "clamp(7px, 3.2cqw, 12px)",
				fontWeight: 600,
				...style,
			}}
		>
			{children}
		</div>
	);
}

function SafeAreaOverlay() {
	return (
		<UiLocalized<"div">
			element={"div"}
			messageProps={["aria-label"]}
			className="pointer-events-none absolute inset-0 select-none"
			style={{ containerType: "inline-size" }}
			role="img"
			aria-label="Safe areas. Titles and navigation at the top, interaction buttons on the right, and username, description and music at the bottom. Edges may be cropped. Keep key content between 22% and 74% of frame height. Coverage varies by platform."
		>
			<div
				className="absolute inset-0"
				style={{
					background: `linear-gradient(to bottom, rgba(15,23,42,.2) ${SUPER_SAFE_TOP}, transparent ${SUPER_SAFE_TOP}, transparent ${SUPER_SAFE_BOTTOM}, rgba(15,23,42,.2) ${SUPER_SAFE_BOTTOM})`,
				}}
			/>
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
			<GuideLabel
				style={{
					top: "9%",
					left: "50%",
					width: "74%",
					transform: "translateX(-50%)",
				}}
			>
				<UiMessage text={"Titles and navigation"} />
				<br />
				<UiMessage text={"may cover this area"} />
			</GuideLabel>
			<GuideLabel
				style={{
					left: "3%",
					top: "48%",
					whiteSpace: "nowrap",
					transform: "translate(-50%, -50%) rotate(-90deg)",
				}}
			>
				<UiMessage text={"Edges may be cropped"} />
			</GuideLabel>
			<GuideLabel
				style={{
					left: "97%",
					top: "48%",
					whiteSpace: "nowrap",
					transform: "translate(-50%, -50%) rotate(-90deg)",
				}}
			>
				<UiMessage text={"Likes, comments and shares"} />
			</GuideLabel>
			<GuideLabel
				style={{
					top: "81%",
					left: "50%",
					width: "74%",
					transform: "translateX(-50%)",
				}}
			>
				<UiMessage text={"Username, description and music"} />
				<br />
				<UiMessage text={"and action buttons"} />
			</GuideLabel>
			{[SUPER_SAFE_TOP, SUPER_SAFE_BOTTOM].map((top) => (
				<div
					key={top}
					className="absolute"
					style={{
						top,
						left: "10%",
						right: "10%",
						borderTop: "2px solid #fbbf24",
						boxShadow: "0 1px 2px rgba(0, 0, 0, 0.65)",
					}}
				/>
			))}
			<GuideLabel
				accent
				style={{
					top: `calc(${SUPER_SAFE_TOP} + 4px)`,
					left: "50%",
					whiteSpace: "nowrap",
					transform: "translateX(-50%)",
					opacity: 0.6,
				}}
			>
				<span dir="ltr">
					<UiMessage text={"SUPER SAFE AREA"} />
				</span>
			</GuideLabel>
			<GuideLabel
				accent
				style={{
					top: `calc(${SUPER_SAFE_BOTTOM} - 4px)`,
					left: "50%",
					width: "80%",
					transform: "translate(-50%, -100%)",
					opacity: 0.6,
				}}
			>
				<UiMessage text={"Keep key content here"} />
			</GuideLabel>
		</UiLocalized>
	);
}
