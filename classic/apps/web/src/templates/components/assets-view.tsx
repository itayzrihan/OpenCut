"use client";

import { useState } from "react";
import { Check, LoaderCircle, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { useAiOAuthStatus } from "@/ai/components/use-ai-oauth-status";
import {
	applyBreakoutPlacements,
	applyTemplateAiCompletion,
	applyProgrammaticEditorialTemplate,
	buildTemplateAiContext,
	chooseTemplateAiPlan,
	normalizeBreakoutPlacements,
	PAPER_GRID_EDITORIAL_TEMPLATE,
} from "@/templates/editorial-template";

export function TemplatesView() {
	const editor = useEditor();
	const { status, login } = useAiOAuthStatus();
	const [isApplying, setIsApplying] = useState(false);

	const applyTemplate = async () => {
		if (isApplying) return;
		setIsApplying(true);
		try {
			const deterministic = applyProgrammaticEditorialTemplate({ editor });
			if (!status.authenticated) {
				toast.warning(
					"The 95% programmatic pass is complete. Connect OpenAI to place Speaker Frame Breakout.",
					{ id: "template-apply" },
				);
				login();
				return;
			}
			const scene = editor.scenes.getActiveSceneOrNull();
			if (!scene) throw new Error("No active scene");
			const context = buildTemplateAiContext({
				tracks: scene.tracks,
				target: deterministic.target,
				totalDurationSeconds: deterministic.totalDurationSeconds,
			});
			let placements;
			try {
				const plan = await chooseTemplateAiPlan({ context });
				applyTemplateAiCompletion({ editor, plan });
				placements = normalizeBreakoutPlacements({
					placements: plan.placements,
					rangeStartSeconds: deterministic.rangeStartSeconds,
					rangeEndSeconds: deterministic.rangeEndSeconds,
				});
			} catch (error) {
				console.warn("Template AI completion failed; using safe fallback", error);
				placements = normalizeBreakoutPlacements({
					placements: [],
					rangeStartSeconds: deterministic.rangeStartSeconds,
					rangeEndSeconds: deterministic.rangeEndSeconds,
				});
					toast.warning("AI completion was unavailable; a safe breakout position was used");
			}
			const applied = await applyBreakoutPlacements({
				editor,
				target: deterministic.target,
				placements,
				onProgress: (message) => toast.loading(message, { id: "template-apply" }),
			});
			toast.success(
				`${PAPER_GRID_EDITORIAL_TEMPLATE.name} applied · ${applied} breakout ${applied === 1 ? "moment" : "moments"}`,
				{ id: "template-apply" },
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Template application failed", {
				id: "template-apply",
			});
		} finally {
			setIsApplying(false);
		}
	};

	return (
		<PanelView title="Templates">
			<div
				className="grid gap-2 pb-3"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))" }}
			>
				<button
					type="button"
					onClick={() => void applyTemplate()}
					disabled={isApplying}
					className="group overflow-hidden rounded-md border bg-card text-left transition-colors hover:border-primary/60 disabled:cursor-wait disabled:opacity-70"
				>
					<div className="relative aspect-video overflow-hidden rounded-sm border bg-[#f8f8f5] transition-colors group-hover:border-primary/60">
						<div className="absolute inset-0 opacity-60 [background-image:linear-gradient(rgba(25,25,25,0.09)_1px,transparent_1px),linear-gradient(90deg,rgba(25,25,25,0.09)_1px,transparent_1px)] [background-size:14px_14px]" />
						<div className="absolute inset-x-[12%] bottom-[8%] h-[38%] overflow-hidden rounded-[12%] bg-gradient-to-b from-slate-400 to-slate-900 shadow-lg">
							<div className="absolute left-1/2 top-[-12%] h-[55%] w-[40%] -translate-x-1/2 rounded-full bg-[#efc7ad]" />
							<div className="absolute inset-x-[20%] bottom-[-10%] h-[64%] rounded-t-[48%] bg-[#315b89]" />
						</div>
						<div className="absolute left-1/2 bottom-[31%] h-[25%] w-[29%] -translate-x-1/2 rounded-t-full bg-[#efc7ad] shadow-[0_-1px_0_rgba(255,255,255,0.5)]" />
						<div className="absolute left-[20%] top-0 h-full w-[3px] bg-white shadow-[0_0_8px_3px_rgba(255,255,255,0.75)]" />
						<div className="absolute right-2 top-2 rounded-full bg-black/75 px-2 py-1 text-[9px] font-semibold tracking-wide text-white">
							95% CODE · 5% AI
						</div>
					</div>
					<div className="flex items-start justify-between gap-1 p-1">
						<div className="min-w-0">
							<div className="flex items-center gap-1 text-[0.7rem] font-medium">
								<Sparkles className="size-3.5 text-primary" />
								{PAPER_GRID_EDITORIAL_TEMPLATE.name}
							</div>
							<p className="hidden">
								{PAPER_GRID_EDITORIAL_TEMPLATE.description}
							</p>
						</div>
						{isApplying ? (
							<LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
						) : (
							<Check className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
						)}
					</div>
				</button>
				<div className="hidden rounded-md border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">
						<strong className="text-foreground">Programmatic pass:</strong> opening reveal, edge feather, captions, RTL checklist, timing-safe layers, and reusable motion are applied locally. OpenAI completes only the reference-driven proof-stage details and Speaker Frame Breakout timing.
				</div>
				<Button
					variant="outline"
					className="hidden"
					disabled={isApplying}
					onClick={() => void applyTemplate()}
				>
					{isApplying ? "Applying template…" : "Apply to imported video"}
				</Button>
			</div>
		</PanelView>
	);
}
