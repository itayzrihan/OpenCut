"use client";
import Link from "next/link";
import { useBatchEdit } from "@/batch/provider";
import { batchEditIsLocked } from "opencut-wasm";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui/resizable";
import { AssetsPanel } from "@/components/editor/panels/assets";
import { PropertiesPanel } from "@/components/editor/panels/properties";
import { Timeline } from "@/timeline/components";
import { PreviewPanelWithOverlays } from "@/preview/components/panel-with-overlays";
import { EditorHeader } from "@/components/editor/editor-header";
import { EditorProvider } from "@/components/providers/editor-provider";
import { Onboarding } from "@/components/editor/onboarding";
import { MigrationDialog } from "@/project/components/migration-dialog";
import { usePanelStore } from "@/editor/panel-store";
import { usePasteMedia } from "@/media/use-paste-media";
import { MobileGate } from "@/components/editor/mobile-gate";
import { useState } from "react";
import { useEditorRenderer } from "@/editor/use-editor";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { ChangelogNotification } from "@/changelog/components/changelog-notification";
import { StoragePersistenceDialog } from "@/services/storage/components/storage-persistence-dialog";
import { ParallaxCanvasEditorBanner } from "@/parallax-story-teller/editor-banner";
import { EditorAgentWorkspace } from "@/editor-agent/overlay";
import { HyperframesExamplesLibrary } from "@/hyperframes/examples-library";

export default function Editor() {
	const params = useParams();
	const projectId = params.project_id as string;
	const search = useSearchParams();
	const router = useRouter();
	const batch = useBatchEdit();
	const job = batch.state.runs
		.flatMap((r) => r.jobs)
		.find((j) => j.projectId === projectId);
	const readOnly = !!job && batchEditIsLocked({ status: job.status });
	const preparing = batch.preparingProjectId === projectId;
	if (!batch.loaded) return <p className="p-8">Checking project status…</p>;

	return (
		<MobileGate>
			<EditorProvider key={projectId} projectId={projectId} readOnly={readOnly}>
				{(readOnly || preparing) && (
					<div className="fixed top-0 inset-x-0 z-100 bg-background border-b p-3 flex justify-between gap-4 text-sm">
						<span role="status">
							{preparing
								? "Saving project for background editing… Your timeline stays open."
								: `Auto Edit · Read-only · ${job?.message ?? ""}`}
						</span>
						<Link href="/projects" className="underline shrink-0">
							Back to Projects
						</Link>
					</div>
				)}
				<div
					inert={readOnly || preparing}
					data-opencut-editor-project={projectId}
					className="bg-background flex h-screen w-screen flex-col overflow-hidden"
					style={readOnly || preparing ? { paddingTop: 48 } : undefined}
				>
					<DegradedRendererBanner />
					<EditorHeader />
					<div className="min-h-0 min-w-0 flex-1">
						<EditorAgentWorkspace>
							{search.get("view") === "examples" ? (
								<HyperframesExamplesLibrary
									projectId={projectId}
									presentation="page"
									onClose={() =>
										router.push(`/editor/${encodeURIComponent(projectId)}`)
									}
								/>
							) : (
								<EditorLayout />
							)}
						</EditorAgentWorkspace>
					</div>
					<Onboarding />
					<MigrationDialog />
					<StoragePersistenceDialog />
					<ChangelogNotification />
				</div>
			</EditorProvider>
		</MobileGate>
	);
}

function DegradedRendererBanner() {
	const isDegraded = useEditorRenderer((e) => e.renderer.isDegraded);
	const [dismissed, setDismissed] = useState(false);
	if (!isDegraded || dismissed) return null;

	return (
		<div className="bg-accent border-b h-9 flex items-center justify-center gap-2 text-xs text-muted-foreground">
			<span>For the best experience, open OpenCut in Chrome.</span>
			<Button
				variant="text"
				size="icon"
				className="p-0 w-auto [&_svg]:size-3.5"
				onClick={() => setDismissed(true)}
				aria-label="Dismiss"
			>
				<HugeiconsIcon icon={Cancel01Icon} />
			</Button>
		</div>
	);
}

function EditorLayout() {
	usePasteMedia();
	const { panels, setPanel } = usePanelStore();

	return (
		<div className="flex size-full min-h-0 flex-col">
			<ParallaxCanvasEditorBanner />
			<ResizablePanelGroup
				direction="vertical"
				className="size-full gap-[0.18rem]"
				onLayout={(sizes) => {
					setPanel({
						panel: "mainContent",
						size: sizes[0] ?? panels.mainContent,
					});
					setPanel({
						panel: "timeline",
						size: sizes[1] ?? panels.timeline,
					});
				}}
			>
				<ResizablePanel
					defaultSize={panels.mainContent}
					minSize={30}
					maxSize={85}
					className="min-h-0"
				>
					<ResizablePanelGroup
						direction="horizontal"
						className="size-full gap-[0.19rem] px-3"
						onLayout={(sizes) => {
							setPanel({ panel: "tools", size: sizes[0] ?? panels.tools });
							setPanel({ panel: "preview", size: sizes[1] ?? panels.preview });
							setPanel({
								panel: "properties",
								size: sizes[2] ?? panels.properties,
							});
						}}
					>
						<ResizablePanel
							defaultSize={panels.tools}
							minSize={15}
							maxSize={40}
							className="min-w-0"
						>
							<AssetsPanel />
						</ResizablePanel>

						<ResizableHandle withHandle />

						<ResizablePanel
							defaultSize={panels.preview}
							minSize={30}
							className="min-h-0 min-w-0 flex-1"
						>
							<PreviewPanelWithOverlays />
						</ResizablePanel>

						<ResizableHandle withHandle />

						<ResizablePanel
							defaultSize={panels.properties}
							minSize={15}
							maxSize={40}
							className="min-w-0"
						>
							<PropertiesPanel />
						</ResizablePanel>
					</ResizablePanelGroup>
				</ResizablePanel>

				<ResizableHandle withHandle />

				<ResizablePanel
					defaultSize={panels.timeline}
					minSize={15}
					maxSize={70}
					className="min-h-0 px-3 pb-3"
				>
					<Timeline />
				</ResizablePanel>
			</ResizablePanelGroup>
		</div>
	);
}
