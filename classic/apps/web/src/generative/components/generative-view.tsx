"use client";
/* eslint-disable @next/next/no-img-element -- Private authenticated artifact previews must retain same-origin cookies and original bytes. */
import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/i18n/toast";
import {
	Send,
	Paperclip,
	Clapperboard,
	Settings,
	Loader2,
	Download,
	Check,
	X,
	Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import { useAiOAuthStatus } from "@/ai/components/use-ai-oauth-status";
import { useDirectorReviewFocus } from "../review-focus";
import { insertSeamless, planSeamless } from "../seamless-connect";
import { applyReplacement, planReplace } from "../replace-clip";
import { TICKS_PER_SECOND } from "@/wasm";
import { directorReply } from "../chat-response";
import { directorPrompt } from "../direction-prompt";
import { directorJobProgress } from "../job-progress";
import { useInterfaceLanguage } from "@/i18n/provider";
import { CHATGPT_STORYBOARD_LABEL } from "../storyboard-model";
import { imageObservation, videoObservations } from "../vision";
import { aiClientFetch } from "@/ai/client-transport";
import {
	api,
	canonical,
	scope,
	status,
	fileUrl,
	downloadFile,
} from "../client";
import type {
	DirectorDocument,
	DirectorStatus,
	DirectorJob,
	DirectorReference,
} from "../types";
const empty: DirectorDocument = {
	messages: [],
	references: [],
	direction: "",
	transcript: "",
	jobs: [],
};
const labels: Record<string, string> = {
	review: "Ready for approval",
	ready: "Ready",
	rejected: "Rejected",
	error: "Needs review",
	uncertain: "Submission unconfirmed",
	session_expired: "Unlock with your PIN",
};
function error(e: unknown) {
	toast.error(e instanceof Error ? e.message : "Director operation failed");
}
export function GenerativeView() {
	const projectId = useEditorProject(
		(e) => e.project.getActiveOrNull()?.metadata.id,
	);
	return projectId ? (
		<DirectorWorkspace key={projectId} projectId={projectId} />
	) : (
		<div className="p-6 text-sm text-muted-foreground">
			<UiMessage text={"Open a project to start directing."} />
		</div>
	);
}
function DirectorWorkspace({ projectId }: { projectId: string }) {
	const editor = useEditor();
	const [document, setDocument] = useState<DirectorDocument>(empty),
		[remote, setRemote] = useState<DirectorStatus | null>(null),
		[text, setText] = useState(""),
		[direction, setDirection] = useState(""),
		[busy, setBusy] = useState(false),
		[now, setNow] = useState(() => Date.now()),
		[settings, setSettings] = useState(false),
		[review, setReview] = useState<DirectorJob | null>(null),
		[model, setModel] = useState("bytedance/seedance-2.5"),
		[duration, setDuration] = useState(8),
		[resolution, setResolution] = useState("480p"),
		[aspect, setAspect] = useState("9:16"),
		[https, setHttps] = useState<Record<string, string>>({}),
		[catalog, setCatalog] = useState<Array<{ id: string; name?: string }>>([]),
		[transcript, setTranscript] = useState(""),
		[boardUpload, setBoardUpload] = useState(false);
	const directionDirty = useRef(false);
	const transcriptDirty = useRef(false);
	const uploadRef = useRef<HTMLInputElement>(null),
		pinRef = useRef<HTMLInputElement>(null),
		confirmPinRef = useRef<HTMLInputElement>(null),
		keyRef = useRef<HTMLInputElement>(null);
	const oauth = useAiOAuthStatus();
	const focus = useDirectorReviewFocus();
	useEffect(() => {
		if (
			focus.accountId !== window.__opencutAccountId ||
			focus.projectId !== projectId ||
			!focus.jobId
		)
			return;
		const job = remote?.jobs.find(
			(j) => j.id === focus.jobId && j.status === "review",
		);
		if (job) {
			queueMicrotask(() => {
				setReview(job);
				focus.clear();
			});
		}
	}, [focus, projectId, remote]);
	const refresh = useCallback(() => {
		if (!projectId) return;
		try {
			const snapshot = canonical({ editor: editor }).document;
			setDocument(snapshot);
			if (!directionDirty.current) setDirection(snapshot.direction);
			if (!transcriptDirty.current) setTranscript(snapshot.transcript ?? "");
		} catch {
			/* Wait for the canonical project to finish loading. */
		}
	}, [editor, projectId]);
	useEffect(() => {
		queueMicrotask(refresh);
		if (!projectId) return;
		const controller = new AbortController();
		const load = () =>
			status({ projectId: projectId, signal: controller.signal })
				.then((value) => {
					setNow(Date.now());
					setRemote(value);
				})
				.catch((e) => {
					if (!controller.signal.aborted) error(e);
				});
		void load();
		void fetch(
			"/api/generative?" +
				new URLSearchParams({
					projectId,
					models: "1",
					account: window.__opencutAccountId ?? "",
				}),
			{ signal: controller.signal },
		)
			.then((r) => r.json())
			.then((r) => setCatalog(r.models ?? []))
			.catch(() => {});
		const timer = setInterval(() => {
			void load();
			refresh();
		}, 5000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [projectId, refresh]);
	async function action(fn: () => Promise<void>) {
		if (busy) return;
		setBusy(true);
		try {
			await fn();
			refresh();
			if (projectId) setRemote(await status({ projectId: projectId }));
		} catch (e) {
			error(e);
		} finally {
			setBusy(false);
		}
	}
	async function upload(files: File[]) {
		if (!files || !projectId) return;
		const { accountId } = scope(editor);
		for (const file of files) {
			const form = new FormData();
			form.append("projectId", projectId);
			form.append("file", file);
			form.append("storyboard", String(boardUpload));
			const response = await fetch("/api/generative", {
				method: "POST",
				headers: { "X-OpenCut-Account": accountId },
				body: form,
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error);
			if (
				data.reference.kind === "audio" &&
				typeof data.durationSeconds === "number"
			) {
				if (data.durationSeconds > 30)
					toast.info(
						"The voice track is longer than 30 seconds. Split it before generating.",
					);
				else setDuration(Math.max(4, Math.ceil(data.durationSeconds)));
			}
			if (
				scope(editor).accountId !== accountId ||
				scope(editor).projectId !== projectId
			)
				throw new Error("Project changed during upload");
			canonical({
				editor: editor,
				change: { type: "reference", reference: data.reference },
			});
		}
		refresh();
	}
	async function chat() {
		if (!text.trim() || !projectId) return;
		const original = scope(editor),
			snapshot = canonical({ editor: editor }),
			user = {
				id: crypto.randomUUID(),
				role: "user" as const,
				text: text.trim(),
			};
		canonical({ editor: editor, change: { type: "message", message: user } });
		setText("");
		refresh();
		const images = [];
		for (const ref of snapshot.document.references
			.filter((r) => r.kind !== "audio")
			.slice(0, 6)) {
			const r = await fetch(fileUrl({ projectId: projectId, id: ref.id }));
			const blob = await r.blob();
			const urls =
				ref.kind === "video"
					? await videoObservations(blob)
					: [await imageObservation(blob)];
			for (const url of urls.slice(0, Math.max(0, 8 - images.length)))
				images.push({ type: "input_image", image_url: url, detail: "low" });
		}
		const response = await aiClientFetch({
			path: "/api/ai/chat",
			init: {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					input: [
						{ role: "system", content: snapshot.instructions },
						{
							role: "user",
							content: [
								{
									type: "input_text",
									text: JSON.stringify({
										conversation: [
											...snapshot.document.messages.slice(-10),
											user,
										],
										references: snapshot.document.references,
										transcript: transcript.slice(0, 60000) || null,
										output: { duration, resolution, aspectRatio: aspect },
										current_direction: direction.slice(0, 60000),
									}),
								},
								...images,
							],
						},
					],
					tools: [],
				}),
			},
		});
		const body = await response.json();
		if (!response.ok) throw new Error(body.error || "Director chat failed");
		if (
			scope(editor).projectId !== original.projectId ||
			scope(editor).accountId !== original.accountId
		)
			throw new Error("Project changed during chat");
		const reply = directorReply(body);
		canonical({
			editor: editor,
			change: {
				type: "message",
				message: { id: crypto.randomUUID(), role: "assistant", text: reply },
			},
		});
		const match = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
		try {
			const json = JSON.parse(match?.[1] ?? reply);
			canonical({
				editor: editor,
				change: {
					type: "direction",
					text: JSON.stringify(json, null, 2),
				},
			});
		} catch {
			/* Conversational questions are valid before a direction is ready. */
		}
	}
	async function prepareVideo() {
		if (!projectId) return;
		const originalScope = scope(editor);
		const snapshot = canonical({ editor: editor });
		const prompt = directorPrompt({
			kind: "video",
			direction,
			transcript,
			instructions: snapshot.instructions,
			aspectRatio: aspect,
		});
		const result = await api<{ job: DirectorJob }>({
			projectId: projectId,
			action: "prepare",
			data: {
				request: {
					projectId,
					kind: "video",
					model,
					prompt,
					duration,
					resolution,
					aspectRatio: aspect,
					referenceIds: snapshot.document.references.map((r) => r.id),
					httpsReferences: https,
				},
			},
		});
		if (
			scope(editor).projectId !== originalScope.projectId ||
			scope(editor).accountId !== originalScope.accountId
		)
			throw new Error("Project changed while preparing generation");
		canonical({
			editor: editor,
			change: {
				type: "job",
				job: { id: result.job.id, digest: result.job.digest, status: "review" },
			},
		});
		setReview(result.job);
	}
	async function transcribe(ref: DirectorReference) {
		if (!projectId) return;
		const original = scope(editor);
		const data = await fetch(
			fileUrl({ projectId: projectId, id: ref.id }),
		).then((r) => r.blob());
		if (
			scope(editor).projectId !== original.projectId ||
			scope(editor).accountId !== original.accountId
		)
			throw new Error("Project changed during transcription");
		const form = new FormData();
		form.append("audio", new File([data], ref.name, { type: ref.mime }));
		form.append("language", "he");
		const r = await fetch("/api/transcription/whisper-cpp", {
			method: "POST",
			body: form,
			headers: { "X-OpenCut-Account": window.__opencutAccountId ?? "" },
		});
		const body = await r.json();
		if (!r.ok) throw new Error(body.error || "Transcription failed");
		const words = body.words ?? body.transcript?.words;
		if (
			scope(editor).projectId !== original.projectId ||
			scope(editor).accountId !== original.accountId
		)
			throw new Error("Project changed during transcription");
		const transcriptText =
			body.text ??
			(Array.isArray(words)
				? words
						.map(
							(w: { text?: string; word?: string }) => w.text ?? w.word ?? "",
						)
						.join(" ")
				: "");
		setTranscript(transcriptText);
		canonical({ editor, change: { type: "transcript", text: transcriptText } });
		toast.info(
			"ASR is provisional. Review the script against the original audio.",
		);
	}
	if (!projectId)
		return (
			<div className="p-6 text-sm text-muted-foreground">
				<UiMessage text={"Open a project to start directing."} />
			</div>
		);
	return (
		<div
			className="flex h-full flex-col bg-background"
			data-testid="generative-view"
		>
			<header className="flex items-center justify-between border-b p-3">
				<div>
					<h2 className="flex items-center gap-2 font-semibold">
						<Clapperboard size={18} />
						<UiMessage text={"The Director"} />
					</h2>
					<p className="text-xs text-muted-foreground">
						<UiMessage text={"Generative Studio"} />
					</p>
				</div>
				<UiLocalized<typeof Button>
					element={Button}
					messageProps={["aria-label"]}
					size="icon"
					variant="ghost"
					aria-label="OpenRouter settings"
					onClick={() => setSettings(true)}
				>
					<Settings size={16} />
				</UiLocalized>
			</header>
			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
				<div className="flex items-center justify-between rounded-lg border p-2 text-xs">
					<span>
						{remote?.configured ? (
							remote.sessionSeconds > 0 ? (
								<UiMessage
									text={"Unlocked · {v0} min"}
									values={{ v0: String(Math.ceil(remote.sessionSeconds / 60)) }}
								/>
							) : (
								<UiMessage
									text={"Vault locked · PIN required for each generation"}
								/>
							)
						) : (
							<UiMessage text={"Set an OpenRouter key to generate video"} />
						)}
					</span>
					<Button size="sm" variant="ghost" onClick={() => setSettings(true)}>
						<Lock size={12} /> <UiMessage text={"Settings"} />
					</Button>
				</div>
				{!oauth.status?.authenticated && (
					<Button variant="outline" onClick={() => void oauth.login()}>
						<UiMessage
							text={"Connect ChatGPT to The Director through the Agent"}
						/>
					</Button>
				)}
				<div className="space-y-3" aria-live="polite">
					{document.messages.map((m) => (
						<article
							key={m.id}
							className={`whitespace-pre-wrap break-words rounded-lg p-3 text-sm ${m.role === "user" ? "bg-secondary" : "border bg-card"}`}
						>
							<strong className="mb-1 block text-xs text-muted-foreground">
								{m.role === "user" ? (
									<UiMessage text={"You"} />
								) : (
									<UiMessage text={"The Director"} />
								)}
							</strong>
							{m.text}
							{m.role === "assistant" && (
								<Button
									size="sm"
									variant="ghost"
									className="mt-2 block"
									disabled={busy}
									onClick={() =>
										void action(async () => {
											canonical({
												editor,
												change: { type: "direction", text: m.text },
											});
											directionDirty.current = false;
											setDirection(m.text);
										})
									}
								>
									<UiMessage text={"Use this reply as direction"} />
								</Button>
							)}
						</article>
					))}
				</div>
				<section>
					<div className="mb-2 flex justify-between text-sm font-medium">
						<span>
							<UiMessage text={"References and files"} />
						</span>
						<div className="flex gap-1">
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									setBoardUpload(false);
									uploadRef.current?.click();
								}}
							>
								<Paperclip size={13} />
								<UiMessage text={"Files"} />
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									setBoardUpload(true);
									uploadRef.current?.click();
								}}
							>
								<UiMessage text={"Storyboard"} />
							</Button>
						</div>
					</div>
					<input
						ref={uploadRef}
						type="file"
						multiple
						hidden
						accept={
							boardUpload
								? "image/png,image/jpeg,image/webp"
								: "image/png,image/jpeg,image/webp,audio/mpeg,audio/wav,audio/mp4,video/mp4,video/quicktime,video/webm"
						}
						onChange={(e) => {
							const files = Array.from(e.target.files ?? []);
							void action(() => upload(files));
							e.target.value = "";
						}}
					/>
					<div className="grid grid-cols-2 gap-2">
						{document.references.map((r) => (
							<div
								key={r.id}
								className="min-w-0 space-y-1 rounded-lg border p-2"
							>
								{r.kind === "image" ? (
									<img
										className="h-28 w-full rounded object-contain"
										src={fileUrl({ projectId: projectId, id: r.id })}
										alt={r.name}
									/>
								) : r.kind === "audio" ? (
									<audio
										className="w-full"
										controls
										src={fileUrl({ projectId: projectId, id: r.id })}
									>
										<UiLocalized<"track">
											element={"track"}
											messageProps={["label"]}
											kind="captions"
											label="Captions not supplied"
											srcLang="und"
										/>
									</audio>
								) : (
									<video
										className="h-28 w-full"
										controls
										src={fileUrl({ projectId: projectId, id: r.id })}
									>
										<UiLocalized<"track">
											element={"track"}
											messageProps={["label"]}
											kind="captions"
											label="Captions not supplied"
											srcLang="und"
										/>
									</video>
								)}
								<p className="truncate text-xs" title={r.name}>
									{r.storyboard ? (
										<>
											<UiMessage text={"Storyboard ·"} />{" "}
										</>
									) : (
										""
									)}
									{r.name}
								</p>
								{r.kind !== "image" && !remote?.publicOrigin && (
									<UiLocalized<"input">
										element={"input"}
										messageProps={["placeholder"]}
										className="w-full rounded border bg-background p-1 text-xs"
										dir="ltr"
										aria-label={`HTTPS link for ${r.name}`}
										placeholder="POCAST HTTPS download link"
										value={https[r.id] ?? ""}
										onChange={(e) =>
											setHttps({ ...https, [r.id]: e.target.value })
										}
									/>
								)}
								{r.kind !== "image" && (
									<Button
										size="sm"
										variant="ghost"
										disabled={busy}
										onClick={() => void action(() => transcribe(r))}
									>
										<UiMessage text={"Local transcription"} />
									</Button>
								)}
								<Button
									size="sm"
									variant="ghost"
									aria-label={`Remove ${r.name}`}
									onClick={() => {
										canonical({
											editor: editor,
											change: { type: "removeReference", id: r.id },
										});
										refresh();
									}}
								>
									<X size={12} />
								</Button>
							</div>
						))}
					</div>
					<p className="mt-2 text-xs text-muted-foreground">
						<UiMessage
							text={
								"Audio and video are shared with the provider through a temporary HTTPS link. Anyone with the link can access it. Up to 100 MB per file."
							}
						/>
					</p>
				</section>
				<details>
					<summary className="cursor-pointer text-sm">
						<UiMessage text={"Source transcript"} />
					</summary>
					<UiLocalized<typeof Textarea>
						element={Textarea}
						messageProps={["aria-label", "placeholder"]}
						aria-label="Original spoken script"
						value={transcript}
						onChange={(e) => {
							transcriptDirty.current = true;
							setTranscript(e.target.value);
						}}
						onBlur={() => {
							transcriptDirty.current = false;
							canonical({
								editor,
								change: { type: "transcript", text: transcript },
							});
							refresh();
						}}
						placeholder="Full transcript. Use the source recording as the reference."
					/>
				</details>
				<section className="space-y-2 rounded-lg border p-3">
					<div className="flex gap-2">
						<UiLocalized<"select">
							element={"select"}
							messageProps={["aria-label"]}
							className="min-w-0 flex-1 rounded border bg-background p-1 text-xs"
							aria-label="Video model"
							value={model}
							onChange={(e) => setModel(e.target.value)}
						>
							{(catalog.length ? catalog : [{ id: model }]).map((m) => (
								<option key={m.id} value={m.id}>
									{m.name ?? m.id}
								</option>
							))}
						</UiLocalized>
						<UiLocalized<"input">
							element={"input"}
							messageProps={["aria-label"]}
							className="w-16 rounded border bg-background p-1"
							type="number"
							aria-label="Duration seconds"
							min={4}
							max={30}
							value={duration}
							onChange={(e) => setDuration(Number(e.target.value))}
						/>
					</div>
					<div className="flex gap-2">
						<UiLocalized<"select">
							element={"select"}
							messageProps={["aria-label"]}
							className="rounded border bg-background p-1 text-xs"
							aria-label="Resolution"
							value={resolution}
							onChange={(e) => setResolution(e.target.value)}
						>
							<option>480p</option>
							<option>720p</option>
						</UiLocalized>
						<UiLocalized<"select">
							element={"select"}
							messageProps={["aria-label"]}
							className="rounded border bg-background p-1 text-xs"
							aria-label="Aspect ratio"
							value={aspect}
							onChange={(e) => setAspect(e.target.value)}
						>
							{["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"].map((x) => (
								<option key={x}>{x}</option>
							))}
						</UiLocalized>
					</div>
					<label className="block text-xs" htmlFor="director-prompt">
						<UiMessage text={"Direction"} />
						<UiLocalized<typeof Textarea>
							element={Textarea}
							messageProps={["placeholder"]}
							className="mt-1 min-h-36 text-xs"
							dir="auto"
							id="director-prompt"
							placeholder="Write or paste direction as plain text, Markdown or JSON"
							value={direction}
							onChange={(e) => {
								directionDirty.current = true;
								setDirection(e.target.value);
							}}
							onBlur={() => {
								directionDirty.current = false;
								if (direction !== document.direction) {
									canonical({
										editor: editor,
										change: { type: "direction", text: direction },
									});
									refresh();
								}
							}}
						/>
					</label>
					<p className="text-xs text-muted-foreground">
						<UiMessage
							text={
								"The Agent connection to ChatGPT supports text direction. You can upload an existing image as a storyboard."
							}
						/>
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							disabled={
								busy ||
								!direction.trim() ||
								!document.references.some((r) => r.storyboard)
							}
							onClick={() => void action(() => prepareVideo())}
						>
							<UiMessage text={"Prepare video for approval"} />
						</Button>
					</div>
				</section>
				{remote?.jobs.map((j) => (
					<section
						key={j.id}
						className="space-y-2 rounded-lg border p-3 text-sm"
					>
						<DirectorJobHeading job={j} now={now} />
						{j.output &&
							(j.kind === "video" ? (
								<video
									controls
									className="max-h-64 w-full rounded"
									src={fileUrl({ projectId: projectId, id: j.output.id })}
								>
									<UiLocalized<"track">
										element={"track"}
										messageProps={["label"]}
										kind="captions"
										label="Captions not supplied"
										srcLang="und"
									/>
								</video>
							) : (
								<UiLocalized<"img">
									element={"img"}
									messageProps={["alt"]}
									className="max-h-64 w-full object-contain"
									alt="Generated physical storyboard"
									src={fileUrl({ projectId: projectId, id: j.output.id })}
								/>
							))}
						{j.cost !== undefined && (
							<p className="text-xs">
								<UiMessage text={"Actual cost $"} />
								{j.cost.toFixed(4)}
							</p>
						)}
						{j.status === "review" && (
							<Button size="sm" onClick={() => setReview(j)}>
								<UiMessage text={"Review and approve"} />
							</Button>
						)}
						{j.output && (
							<Button
								size="sm"
								variant="outline"
								onClick={() =>
									downloadFile({
										url: fileUrl({
											projectId: projectId,
											id: j.output!.id,
											download: true,
										}),
										name: j.output!.name,
									})
								}
							>
								<Download size={13} />
								<UiMessage text={"Download"} />
							</Button>
						)}
						{(j.seamless || j.replacement) && j.status === "ready" && (
							<Button
								size="sm"
								variant="outline"
								onClick={() =>
									void action(async () => {
										const mediaId = canonical({ editor }).document.jobs.find(
											(link) => link.id === j.id,
										)?.mediaId;
										if (!mediaId)
											throw new Error(
												"Wait for the generated video to appear in Media",
											);
										const input = { editor, job: j, mediaId };
										const inserted = j.replacement ? applyReplacement(input) : insertSeamless(input);
										if (inserted)
											toast.success(
												j.replacement ? "Clip replaced at its original duration" : "Seamless Connect inserted on the timeline",
											);
									})
								}
							>
								{j.replacement ? <UiMessage text={"Apply replacement"} /> : <UiMessage text={"Insert at original cut"} />}
							</Button>
						)}
					</section>
				))}
			</div>
			<form
				className="flex items-end gap-2 border-t p-3"
				onSubmit={(e) => {
					e.preventDefault();
					void action(chat);
				}}
			>
				<UiLocalized<typeof Textarea>
					element={Textarea}
					messageProps={["aria-label", "placeholder"]}
					maxLength={12000}
					aria-label="Message The Director"
					placeholder="Describe what you want to see…"
					value={text}
					onChange={(e) => setText(e.target.value)}
					className="max-h-32 min-h-16"
				/>
				<UiLocalized<typeof Button>
					element={Button}
					messageProps={["aria-label"]}
					type="submit"
					size="icon"
					aria-label="Send to The Director"
					disabled={busy || !text.trim() || !oauth.status?.authenticated}
				>
					{busy ? (
						<Loader2 size={16} className="animate-spin" />
					) : (
						<Send size={16} />
					)}
				</UiLocalized>
			</form>
			{settings && (
				<UiLocalized<"div">
					element={"div"}
					messageProps={["aria-label"]}
					className="absolute inset-0 z-30 flex items-center justify-center bg-background/95 p-5"
					role="dialog"
					aria-modal="true"
					aria-label="OpenRouter vault"
				>
					<form
						className="w-full space-y-4 rounded-xl border p-4"
						onSubmit={(e) => {
							e.preventDefault();
							const pin = pinRef.current?.value ?? "",
								apiKey = keyRef.current?.value;
							if (!remote?.configured && pin !== confirmPinRef.current?.value) {
								toast.error("The PIN entries do not match");
								return;
							}
							if (confirmPinRef.current) confirmPinRef.current.value = "";
							if (pinRef.current) pinRef.current.value = "";
							if (keyRef.current) keyRef.current.value = "";
							void action(async () => {
								await api({
									projectId: projectId,
									action: remote?.configured ? "unlock" : "setup",
									data: {
										pin,
										...(!remote?.configured ? { apiKey } : {}),
									},
								});
								setSettings(false);
							});
						}}
					>
						<h3 className="font-semibold">
							<UiMessage text={"OpenRouter · Encrypted vault"} />
						</h3>
						<p className="text-xs text-muted-foreground">
							<UiMessage
								text={
									"Your key is encrypted on the account server. Enter your PIN to approve each paid generation. Free checks and downloads stay available for 15 minutes after unlocking."
								}
							/>
						</p>
						{!remote?.configured && (
							<UiLocalized<"input">
								element={"input"}
								messageProps={["aria-label", "placeholder"]}
								className="w-full rounded border bg-background p-2"
								ref={keyRef}
								type="password"
								autoComplete="off"
								aria-label="OpenRouter API key"
								placeholder="OpenRouter API key"
								required
							/>
						)}
						<UiLocalized<"input">
							element={"input"}
							messageProps={["aria-label", "placeholder"]}
							className="w-full rounded border bg-background p-2"
							ref={pinRef}
							type="password"
							pattern="[0-9]{6,16}"
							inputMode="numeric"
							autoComplete="off"
							aria-label="Vault PIN"
							placeholder="PIN with 6–16 digits"
							required
						/>
						{!remote?.configured && (
							<UiLocalized<"input">
								element={"input"}
								messageProps={["aria-label", "placeholder"]}
								className="w-full rounded border bg-background p-2"
								ref={confirmPinRef}
								type="password"
								pattern="[0-9]{6,16}"
								inputMode="numeric"
								autoComplete="off"
								aria-label="Confirm vault PIN"
								placeholder="Confirm PIN"
								required
							/>
						)}
						<Button type="submit" disabled={busy}>
							{remote?.configured ? (
								<UiMessage text={"Unlock for free checks"} />
							) : (
								<UiMessage text={"Save encrypted key"} />
							)}
						</Button>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setSettings(false)}
						>
							<UiMessage text={"Close"} />
						</Button>
						{remote?.sessionSeconds ? (
							<Button
								type="button"
								variant="outline"
								onClick={() =>
									void action(async () => {
										await api({ projectId: projectId, action: "lock" });
										setSettings(false);
									})
								}
							>
								<UiMessage text={"Lock"} />
							</Button>
						) : null}
					</form>
				</UiLocalized>
			)}
			{review && (
				<ReviewDialog
					job={review}
					projectId={projectId}
					busy={busy}
					close={() => setReview(null)}
					run={action}
				/>
			)}
		</div>
	);
}
function DirectorJobHeading({ job, now }: { job: DirectorJob; now: number }) {
	const { t } = useInterfaceLanguage();
	const progress = directorJobProgress({ job, now, t });
	return (
		<>
			<div className="flex flex-wrap justify-between gap-2">
				<strong>
					{job.replacement ? (
						<UiMessage text={"Replace clip"} />
					) : job.referenceImage ? (
						<UiMessage text={"Replacement reference image"} />
					) : job.seamless ? (
						"Seamless Connect"
					) : job.kind === "video" ? (
						<UiMessage text={"Video"} />
					) : (
						<UiMessage text={"Storyboard"} />
					)}
				</strong>
				<span role="status" className="inline-flex items-center gap-2">
					{progress && (
						<Loader2 aria-hidden="true" className="animate-spin" size={15} />
					)}
					{progress?.label ?? t(labels[job.status] ?? job.status)}
				</span>
			</div>
			{job.provider === "chatgpt" && (
				<p className="text-xs text-muted-foreground">
					{CHATGPT_STORYBOARD_LABEL}
				</p>
			)}
			{progress?.detail && (
				<p className="text-xs tabular-nums">{progress.detail}</p>
			)}
			{!progress && (
				<p className="text-xs text-muted-foreground">{job.message}</p>
			)}
		</>
	);
}
function ReviewDialog({
	job,
	projectId,
	busy,
	close,
	run,
}: {
	job: DirectorJob;
	projectId: string;
	busy: boolean;
	close: () => void;
	run: (f: () => Promise<void>) => Promise<void>;
}) {
	const editor = useEditor();
	const pin = useRef<HTMLInputElement>(null);
	const chatgpt = job.provider === "chatgpt";
	return (
		<UiLocalized<"div">
			element={"div"}
			messageProps={["aria-label"]}
			className="absolute inset-0 z-30 flex flex-col bg-background"
			role="dialog"
			aria-modal="true"
			aria-label={
				chatgpt ? "Review ChatGPT storyboard" : "Review paid generation"
			}
		>
			<div className="flex justify-between border-b p-3">
				<h3 className="font-semibold">
					<UiMessage text={"Approve one generation ·"} />{" "}
					{job.replacement ? <UiMessage text={"Replace clip"} /> : job.referenceImage
						? <UiMessage text={"Replacement reference image"} /> : job.kind}
				</h3>
				<Button variant="ghost" size="icon" onClick={close}>
					<X size={16} />
				</Button>
			</div>
			<div className="flex-1 space-y-3 overflow-y-auto p-3">
				<p className="text-xs">
					{chatgpt ? (
						<UiMessage
							text={"{v0} · adapter model "}
							values={{ v0: String(CHATGPT_STORYBOARD_LABEL) }}
						/>
					) : (
						<>
							<UiMessage text={"OpenRouter ·"} />{" "}
						</>
					)}
					{job.model}
					{job.kind === "video" &&
						` · ${job.duration}s · ${job.resolution} · ${job.aspectRatio}`}
				</p>
				{job.replacement && (
					<p className="text-xs">
						<UiMessage text={"Timeline duration"} /> · {Number((job.replacement.durationTicks / TICKS_PER_SECOND).toFixed(5))}s
					</p>
				)}
				<p className="rounded border p-2 text-sm">
					{chatgpt ? (
						<UiMessage
							text={
								"Image generation through the Agent connection is unavailable. You can upload an existing storyboard image."
							}
						/>
					) : (
						<UiMessage
							text={
								"OpenRouter charges for this generation. The final price can vary. Approval submits one request."
							}
						/>
					)}
				</p>
				<div className="grid grid-cols-2 gap-2">
					{job.references.map((r) => (
						<div key={r.id}>
							{r.kind === "image" ? (
								<img
									className="max-h-40 w-full object-contain"
									src={fileUrl({ projectId: projectId, id: r.id })}
									alt={r.name}
								/>
							) : r.kind === "audio" ? (
								<audio
									className="w-full"
									controls
									src={fileUrl({ projectId: projectId, id: r.id })}
								>
									<UiLocalized<"track">
										element={"track"}
										messageProps={["label"]}
										kind="captions"
										label="Captions not supplied"
										srcLang="und"
									/>
								</audio>
							) : (
								<video
									controls
									className="max-h-40 w-full"
									src={fileUrl({ projectId: projectId, id: r.id })}
								>
									<UiLocalized<"track">
										element={"track"}
										messageProps={["label"]}
										kind="captions"
										label="Captions not supplied"
										srcLang="und"
									/>
								</video>
							)}
							<span className="text-xs">
								{r.storyboard ? (
									<>
										<UiMessage text={"Storyboard ·"} />{" "}
									</>
								) : (
									""
								)}
								{r.name}
							</span>
						</div>
					))}
				</div>
				<pre
					className="whitespace-pre-wrap break-words rounded border p-2 text-xs"
					dir="auto"
				>
					{job.prompt}
				</pre>
				<p className="break-all text-[10px]" dir="ltr">
					<UiMessage text={"SHA256:"} /> {job.digest}
				</p>
			</div>
			<form
				className="space-y-2 border-t p-3"
				onSubmit={(e) => {
					e.preventDefault();
					if (chatgpt) return;
					const value = pin.current?.value;
					if (pin.current) pin.current.value = "";
					void run(async () => {
						if (job.replacement && (
							scope(editor).projectId !== job.projectId ||
							planReplace({ editor, target: job.replacement }).anchor !== job.replacement.anchor
						))
							throw new Error("The selected clip changed. Prepare the replacement again.");
						if (job.seamless) {
							const { anchor, ...target } = job.seamless;
							if (
								scope(editor).projectId !== job.projectId ||
								planSeamless({ editor, target }).anchor !== anchor
							)
								throw new Error(
									"The source clips changed. Prepare the connection again.",
								);
						}
						await api({
							projectId: projectId,
							action: "approve",
							data: {
								id: job.id,
								digest: job.digest,
								...(chatgpt ? {} : { pin: value }),
								confirmed: true,
							},
						});
						close();
					});
				}}
			>
				{!chatgpt && (
					<UiLocalized<"input">
						element={"input"}
						messageProps={["aria-label", "placeholder"]}
						className="w-full rounded border bg-background p-2"
						aria-label="PIN for this paid request"
						ref={pin}
						type="password"
						inputMode="numeric"
						pattern="[0-9]{6,16}"
						autoComplete="off"
						placeholder="PIN to approve this request"
						required
					/>
				)}
				<div className="flex gap-2">
					<Button type="submit" disabled={busy || chatgpt}>
						<Check size={14} />
						{chatgpt ? (
							<UiMessage text={"Approve and generate in ChatGPT"} />
						) : (
							<UiMessage text={"Approve and generate"} />
						)}
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() =>
							void run(async () => {
								await api({
									projectId: projectId,
									action: "reject",
									data: { id: job.id },
								});
								close();
							})
						}
					>
						<UiMessage text={"Reject"} />
					</Button>
				</div>
				<p className="text-xs text-muted-foreground">
					<UiMessage text={"Each approval submits one generation request."} />
				</p>
			</form>
		</UiLocalized>
	);
}
