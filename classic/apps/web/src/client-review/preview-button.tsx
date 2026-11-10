"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	Eye,
	Copy,
	ExternalLink,
	LockKeyhole,
	RefreshCw,
	Check,
	MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogBody,
} from "@/components/ui/dialog";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import { Message } from "@/i18n/message";
import { toast } from "@/i18n/toast";
import { checkExportEncoder } from "@/export/video-encoding";
import { mediaTime } from "@/wasm/media-time";
import type { ExportResult, ExportFormat } from "@/export";
import {
	reviewRequest,
	jsonRequest,
	reviewTime,
	type OwnerReview,
} from "./client";
import { readClientReview, type ClientReviewShare } from "./canonical";
export function PreviewButton() {
	const editor = useEditor(),
		project = useEditorProject((e) => e.project.getActiveOrNull()),
		projectId = project?.metadata.id;
	const [open, setOpen] = useState(false),
		[shares, setShares] = useState<OwnerReview[]>([]),
		[selected, setSelected] = useState<string | null>(null),
		[password, setPassword] = useState(""),
		[protect, setProtect] = useState(false),
		[busy, setBusy] = useState(false),
		[status, setStatus] = useState(""),
		[error, setError] = useState(""),
		[progress, setProgress] = useState(0),
		[revoking, setRevoking] = useState<string | null>(null);
	const syncing = useRef(false),
		mounted = useRef(true),
		abort = useRef<AbortController | null>(null),
		exportOwner = useRef<object | null>(null);
	const [feedbackDeferred, setFeedbackDeferred] = useState(() =>
		editor.command.canRedo(),
	);
	useEffect(
		() =>
			editor.command.subscribeHistory(() =>
				setFeedbackDeferred(editor.command.canRedo()),
			),
		[editor],
	);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			abort.current?.abort();
			if (
				exportOwner.current &&
				editor.project.getExportState().options === exportOwner.current
			)
				editor.project.cancelExport();
		};
	}, [editor.project]);
	const current =
		shares.find((s) => s.shareId === selected) ??
		shares.find((s) => s.ready && !s.revoked) ??
		null;
	const synchronize = useCallback(
		(items: OwnerReview[]) => {
			if (!projectId) return;
			// Importing polled feedback is an edit. Preserve the user's redo chain.
			if (editor.command.canRedo()) return;
			const accountId = window.__opencutAccountId;
			if (
				!accountId ||
				editor.project.getActiveOrNull()?.metadata.id !== projectId
			)
				return;
			for (const item of items) {
				if (!item.ready) continue;
				const state = readClientReview(editor.project.getActiveOrNull());
				if (
					!state.shares.some(
						(s) => s.shareId === item.shareId && s.version === item.version,
					)
				) {
					const share: ClientReviewShare = {
						shareId: item.shareId,
						version: item.version,
						sceneId: item.sceneId,
						durationTicks: item.durationTicks,
						createdAt: item.createdAt,
						title: item.title,
					};
					editor.command.invokeCanonicalControl({
						accountId,
						projectId,
						capabilityId: "project.classic.review.share.record",
						input: { share },
					});
				}
				const known = readClientReview(
					editor.project.getActiveOrNull(),
				).comments;
				const changed = item.comments.filter((c) => {
					const old = known.find((x) => x.id === c.id);
					return !old || old.serverRevision < c.serverRevision;
				});
				for (let i = 0; i < changed.length; i += 25)
					editor.command.invokeCanonicalControl({
						accountId,
						projectId,
						capabilityId: "project.classic.review.comments.import",
						input: {
							shareId: item.shareId,
							shareVersion: item.version,
							comments: changed.slice(i, i + 25),
						},
					});
			}
		},
		[editor, projectId],
	);
	const refresh = useCallback(async () => {
		if (!projectId || syncing.current) return;
		syncing.current = true;
		const account = window.__opencutAccountId;
		try {
			const items = await reviewRequest<OwnerReview[]>({
				path: `/api/client-review/owner?projectId=${encodeURIComponent(projectId)}`,
			});
			if (
				!mounted.current ||
				editor.project.getActiveOrNull()?.metadata.id !== projectId ||
				window.__opencutAccountId !== account
			)
				return;
			synchronize(items);
			setShares(items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
		} catch (e) {
			if (mounted.current)
				setError(
					e instanceof Error ? e.message : "Could not load client feedback",
				);
		} finally {
			syncing.current = false;
		}
	}, [editor, projectId, synchronize]);
	useEffect(() => {
		let cancelled = false;
		queueMicrotask(() => {
			if (cancelled) return;
			setShares([]);
			setSelected(null);
			setError("");
			void refresh();
		});
		const timer = setInterval(() => {
			if (!document.hidden) void refresh();
		}, 20000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [refresh]);
	useEffect(() => {
		let cancelled = false;
		queueMicrotask(() => {
			if (!cancelled && open) void refresh();
		});
		return () => {
			cancelled = true;
		};
	}, [open, refresh]);
	const create = async () => {
		if (
			!project ||
			busy ||
			abort.current ||
			editor.project.getExportState().isExporting
		)
			return;
		const account = window.__opencutAccountId;
		if (!account) return;
		const capturedProject = project.metadata.id,
			scene = editor.scenes.getActiveScene(),
			durationTicks = editor.timeline.getTotalDuration(),
			previewTitle = `${project.metadata.name} · ${scene.name}`
				.replaceAll("\0", "")
				.trim()
				.slice(0, 160),
			fingerprint = JSON.stringify({ scene, settings: project.settings });
		let draft: OwnerReview | null = null,
			result: ExportResult | undefined;
		const controller = new AbortController();
		abort.current = controller;
		setBusy(true);
		setError("");
		setProgress(0);
		const check = () => {
			if (controller.signal.aborted)
				throw new Error("Preview creation cancelled");
			const active = editor.project.getActiveOrNull();
			if (
				!mounted.current ||
				active?.metadata.id !== capturedProject ||
				window.__opencutAccountId !== account ||
				JSON.stringify({
					scene: editor.scenes.getActiveScene(),
					settings: active.settings,
				}) !== fingerprint
			)
				throw new Error(
					"The sequence changed while preparing this preview. Create a new preview from the current edit.",
				);
		};
		const unsubscribe = editor.project.subscribe(() => {
			const state = editor.project.getExportState();
			if (mounted.current && state.isExporting) {
				setProgress(Math.round(state.progress * 100));
				setStatus(state.phase || "Rendering in this browser…");
			}
		});
		try {
			const existing = await reviewRequest<OwnerReview[]>({
				path: `/api/client-review/owner?projectId=${encodeURIComponent(capturedProject)}`,
				init: { signal: controller.signal },
			});
			check();
			if (existing.filter((item) => item.ready || !item.revoked).length >= 100)
				throw new Error(
					"This project has reached its 100 preview-version limit. Use a new project for further versions.",
				);
			if (durationTicks <= 0)
				throw new Error("Add content to the sequence before sharing a preview");
			if (protect && password.length < 8)
				throw new Error("Use at least 8 characters for the review password");
			setStatus("Checking this browser's video encoder…");
			const preferences = {
				resolution: "project",
				encoding: "compatible",
			} as const;
			let format: ExportFormat = "mp4";
			let plan = editor.command.planExport({
				sceneId: scene.id,
				preferences,
				quality: "medium",
				format,
			});
			try {
				await checkExportEncoder(plan);
			} catch {
				format = "webm";
				plan = editor.command.planExport({
					sceneId: scene.id,
					preferences,
					quality: "medium",
					format,
				});
				await checkExportEncoder(plan);
			}
			if (plan.estimatedBytes > 512 * 1024 * 1024)
				throw new Error(
					"This preview is estimated to exceed 512 MB. Share a shorter sequence or lower the project resolution.",
				);
			check();
			setStatus("Rendering in this browser…");
			if (editor.project.getExportState().isExporting)
				throw new Error(
					"Another export started. Wait for it to finish before creating a preview.",
				);
			const exportOptions = {
				preferences,
				format,
				quality: "medium" as const,
				fps: project.settings.fps,
				includeAudio: true,
			};
			exportOwner.current = exportOptions;
			result = await editor.project.export({ options: exportOptions });
			exportOwner.current = null;
			check();
			if (result.cancelled) throw new Error("Preview creation cancelled");
			if (!result.success)
				throw new Error(result.error || "Preview render failed");
			const blob =
				result.file ??
				(result.buffer
					? new Blob([result.buffer], { type: `video/${format}` })
					: null);
			if (!blob) throw new Error("The browser did not return a preview video");
			if (blob.size > 512 * 1024 * 1024)
				throw new Error("The preview is larger than the 512 MB sharing limit");
			setStatus("Uploading the finished preview…");
			setProgress(0);
			draft = await reviewRequest<OwnerReview>({
				path: "/api/client-review/owner",
				init: {
					...jsonRequest({
						method: "POST",
						data: {
							projectId: capturedProject,
							sceneId: scene.id,
							title: previewTitle,
							durationTicks,
							size: blob.size,
							mime: `video/${format}`,
							password: protect ? password : undefined,
						},
					}),
					signal: controller.signal,
				},
			});
			check();
			let ready = draft;
			const chunkSize = 8 * 1024 * 1024;
			for (let offset = 0; offset < blob.size; offset += chunkSize) {
				check();
				const chunk = blob.slice(
					offset,
					Math.min(offset + chunkSize, blob.size),
					`video/${format}`,
				);
				ready = await reviewRequest<OwnerReview>({
					path: `/api/client-review/owner/${draft.shareId}`,
					init: {
						method: "PUT",
						headers: {
							"Content-Type": `video/${format}`,
							"Upload-Offset": String(offset),
						},
						body: chunk,
						signal: controller.signal,
					},
				});
				setProgress(
					Math.round(
						(Math.min(offset + chunkSize, blob.size) / blob.size) * 100,
					),
				);
			}
			if (!ready.ready)
				throw new Error("The preview upload was not completed.");
			check();
			synchronize([ready]);
			setShares((prior) => [ready, ...prior]);
			setSelected(ready.shareId);
			draft = null;
			setPassword("");
			toast.success("Client preview is ready");
		} catch (e) {
			if (mounted.current && window.__opencutAccountId === account)
				setError(e instanceof Error ? e.message : "Could not create preview");
			if (draft)
				await fetch(`/api/client-review/owner/${draft.shareId}`, {
					method: "DELETE",
					headers: { "X-OpenCut-Account": account },
				}).catch(() => {});
		} finally {
			unsubscribe();
			await result?.dispose?.();
			if (result && editor.project.getExportState().result === result)
				editor.project.clearExportState();
			exportOwner.current = null;
			if (mounted.current) {
				setBusy(false);
				setStatus("");
			}
			abort.current = null;
		}
	};
	const resolve = async ({
		id,
		resolved,
	}: {
		id: string;
		resolved: boolean;
	}) => {
		if (!current) return;
		const account = window.__opencutAccountId;
		const capturedProject = projectId;
		try {
			const updated = await reviewRequest<OwnerReview>({
				path: `/api/client-review/owner/${current.shareId}`,
				init: jsonRequest({
					method: "PATCH",
					data: { commentId: id, resolved },
				}),
			});
			if (
				!mounted.current ||
				window.__opencutAccountId !== account ||
				editor.project.getActiveOrNull()?.metadata.id !== capturedProject
			)
				return;
			synchronize([updated]);
			setShares((prior) =>
				prior.map((s) => (s.shareId === updated.shareId ? updated : s)),
			);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not update feedback");
		}
	};
	const revoke = async () => {
		if (!revoking) return;
		try {
			await reviewRequest({
				path: `/api/client-review/owner/${revoking}`,
				init: {
					method: "DELETE",
				},
			});
			setRevoking(null);
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not revoke link");
		}
	};
	const field =
		"w-full rounded-md border border-border bg-background px-3 py-2 text-sm";
	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				onClick={() => setOpen(true)}
				disabled={!project}
				title="Client Preview"
			>
				<Eye />
				<span className="hidden sm:inline">
					<Message text="Preview" />
				</span>
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!busy) setOpen(next);
				}}
			>
				<DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
					<DialogHeader>
						<DialogTitle>
							<Message text="Client Preview" />
						</DialogTitle>
						<DialogDescription>
							<Message text="Share a fixed version of your sequence and collect feedback at the exact moment it matters." />
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						{feedbackDeferred && (
							<p role="status" className="mb-4 text-sm text-muted-foreground">
								<Message text="Feedback sync resumes after redo or your next edit." />
							</p>
						)}
						<div className="grid gap-6 md:grid-cols-2">
							<section className="space-y-4">
								<h3 className="font-medium">
									<Message text="Create a new preview" />
								</h3>
								<p className="text-xs leading-5 text-muted-foreground">
									<Message text="The active sequence renders locally in your browser. Only the finished video is uploaded for sharing. Each link is a separate version, expires in 90 days, and can be revoked anytime. Up to 512 MB per preview." />
								</p>
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={protect}
										onChange={(e) => setProtect(e.target.checked)}
										disabled={busy}
									/>
									<LockKeyhole size={14} />
									<Message text="Protect with a password" />
								</label>
								{protect && (
									<label className="block text-sm">
										<Message text="Review password" />
										<input
											className={`${field} mt-2`}
											type="password"
											autoComplete="new-password"
											minLength={8}
											maxLength={128}
											value={password}
											onChange={(e) => setPassword(e.target.value)}
											disabled={busy}
											placeholder="At least 8 characters"
										/>
									</label>
								)}
								<Button
									className="w-full"
									onClick={() => void create()}
									disabled={
										busy ||
										shares.filter((item) => item.ready || !item.revoked)
											.length >= 100 ||
										editor.project.getExportState().isExporting ||
										!!(protect && password.length < 8)
									}
								>
									<Eye />
									<Message
										text={busy ? "Preparing preview…" : "Render & create link"}
									/>
								</Button>
								{busy && (
									<div
										role="status"
										className="space-y-2 text-xs text-muted-foreground"
									>
										<p>{status}</p>
										<progress className="w-full" max={100} value={progress} />
										<Button
											size="sm"
											variant="outline"
											onClick={() => {
												abort.current?.abort();
												if (
													exportOwner.current &&
													editor.project.getExportState().options ===
														exportOwner.current
												)
													editor.project.cancelExport();
											}}
										>
											<Message text="Cancel" />
										</Button>
									</div>
								)}
							</section>
							<section className="space-y-3">
								<div className="flex items-center justify-between">
									<h3 className="font-medium">
										<Message text="Shared versions" />
									</h3>
									<Button
										variant="ghost"
										size="icon"
										title="Refresh client feedback"
										onClick={() => void refresh()}
									>
										<RefreshCw />
									</Button>
								</div>
								{!shares.length && (
									<p className="text-sm text-muted-foreground">
										<Message text="Your preview links will appear here." />
									</p>
								)}
								<div className="max-h-60 space-y-2 overflow-y-auto">
									{shares.map((s) => (
										<button
											type="button"
											key={s.shareId}
											className={`w-full rounded-lg border p-3 text-left text-sm ${current?.shareId === s.shareId ? "border-primary bg-primary/5" : "border-border"}`}
											onClick={() => setSelected(s.shareId)}
										>
											<span className="block truncate">{s.title}</span>
											<span className="mt-1 block text-xs text-muted-foreground">
												{new Date(s.createdAt).toLocaleString()} ·{" "}
												{s.version.slice(0, 8)} ·{" "}
												{s.revoked
													? "Revoked"
													: !s.ready
														? "Incomplete"
														: s.passwordProtected
															? "Password protected"
															: "Public link"}
											</span>
										</button>
									))}
								</div>
								{current?.ready && !current.revoked && (
									<>
										<div className="flex gap-2">
											<Button
												size="sm"
												variant="outline"
												onClick={() =>
													void navigator.clipboard.writeText(current.url).then(
														() => toast.success("Preview link copied"),
														() =>
															setError(
																"Could not copy. Select the link below to copy it manually.",
															),
													)
												}
											>
												<Copy />
												<Message text="Copy link" />
											</Button>
											<Button size="sm" variant="outline" asChild>
												<a
													href={current.url}
													target="_blank"
													rel="noopener noreferrer"
												>
													<ExternalLink />
													<Message text="Open" />
												</a>
											</Button>
											<Button
												size="sm"
												variant="destructive-foreground"
												onClick={() => setRevoking(current.shareId)}
											>
												<Message text="Revoke" />
											</Button>
										</div>
										<input
											readOnly
											aria-label="Preview link"
											className={field}
											value={current.url}
											onFocus={(e) => e.target.select()}
										/>
									</>
								)}
								{revoking && (
									<div className="rounded-lg border border-destructive/40 p-3 text-sm">
										<p>
											<Message text="Revoke this link? Viewers will immediately lose access. Saved feedback stays in this project." />
										</p>
										<div className="mt-3 flex gap-2">
											<Button
												size="sm"
												variant="destructive"
												onClick={() => void revoke()}
											>
												<Message text="Revoke link" />
											</Button>
											<Button
												size="sm"
												variant="outline"
												onClick={() => setRevoking(null)}
											>
												<Message text="Keep link" />
											</Button>
										</div>
									</div>
								)}
							</section>
						</div>
						{error && (
							<p
								role="alert"
								className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
							>
								{error}
							</p>
						)}
						{current && (
							<section className="border-t pt-5">
								<h3 className="mb-2 flex items-center gap-2 font-medium">
									<MessageSquare size={16} />
									<Message text="Timeline feedback" />
									<span className="ml-auto text-xs font-normal text-muted-foreground">
										Version {current.version.slice(0, 8)}
									</span>
								</h3>
								<p className="mb-4 text-xs text-muted-foreground">
									<Message text="Feedback refers to this published version. Time positions may differ after you edit the sequence. Open the preview to compare." />
								</p>
								{!current.comments.length && (
									<p className="text-sm text-muted-foreground">
										<Message text="No feedback yet. New comments sync here automatically." />
									</p>
								)}
								<div className="max-h-72 space-y-2 overflow-auto">
									{current.comments.map((c) => (
										<article key={c.id} className="rounded-lg border p-3">
											<div className="mb-2 flex items-center gap-2">
												<Button
													size="sm"
													variant="secondary"
													onClick={() => {
														void editor.scenes
															.switchToScene({ sceneId: c.sceneId })
															.then(() => {
																editor.playback.seek({
																	time: mediaTime({
																		ticks: Math.min(
																			c.timeTicks,
																			editor.timeline.getTotalDuration(),
																		),
																	}),
																});
																setOpen(false);
															})
															.catch(() =>
																setError(
																	"The sequence for this review is no longer in the project. Open the preview link to see it.",
																),
															);
													}}
												>
													{reviewTime(c.timeTicks)}
												</Button>
												<span
													className="text-xs text-muted-foreground"
													dir="auto"
												>
													{c.authorName}
												</span>
												<Button
													size="sm"
													variant="ghost"
													className="ml-auto"
													disabled={current.revoked}
													onClick={() =>
														void resolve({
															id: c.id,
															resolved: !c.resolved,
														})
													}
												>
													{c.resolved && <Check />}
													<Message
														text={c.resolved ? "Resolved" : "Mark resolved"}
													/>
												</Button>
											</div>
											<p
												className="whitespace-pre-wrap break-words text-sm"
												dir="auto"
											>
												{c.body}
											</p>
										</article>
									))}
								</div>
							</section>
						)}
					</DialogBody>
				</DialogContent>
			</Dialog>
		</>
	);
}
