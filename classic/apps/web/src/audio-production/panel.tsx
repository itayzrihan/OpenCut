"use client";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	useEditor,
	useEditorHistory,
	useEditorProject,
} from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Message } from "@/i18n/message";
import { useInterfaceLanguage } from "@/i18n/provider";
import { processMediaAssets } from "@/media/processing";
import {
	audioApi,
	audioFileUrl,
	editAudioDraft,
	readAudioDrafts,
} from "./client";
import {
	audioDraftSchema,
	type AudioDraft,
	type AudioJob,
	type AudioStatus,
} from "./types";
import { AgentSettingsSection } from "@/editor-agent/settings-section";
import type { EditorCore } from "@/core";
import { audioDraftsSnapshot } from "./panel-snapshot";

export function ElevenLabsConnectionSettings({
	projectId,
}: {
	projectId: string;
}) {
	const [key, setKey] = useState(""),
		[pin, setPin] = useState(""),
		[configured, setConfigured] = useState(false),
		[busy, setBusy] = useState(false),
		[error, setError] = useState("");
	const id = useId();
	useEffect(() => {
		const c = new AbortController();
		void audioApi<AudioStatus>({ projectId, signal: c.signal })
			.then((s) => setConfigured(s.configured))
			.catch(() => {});
		return () => c.abort();
	}, [projectId]);
	async function save() {
		setBusy(true);
		setError("");
		try {
			await audioApi({
				projectId,
				action: configured ? "unlock" : "setup",
				data: { apiKey: key, pin },
			});
			setKey("");
			setPin("");
			setConfigured(true);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Connection failed");
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="space-y-3 text-sm">
			<p className="text-muted-foreground">
				<Message text="Connect ElevenLabs for speech, dialogue, sound effects and music. The API key is encrypted with your PIN. Each generation requires a separate approval." />
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
				className="space-y-3"
			>
				{!configured && (
					<label className="block space-y-1" htmlFor={id + "-key"}>
						<span>ElevenLabs API key</span>
						<Input
							id={id + "-key"}
							type="password"
							autoComplete="off"
							required
							maxLength={1024}
							value={key}
							onChange={(e) => setKey(e.target.value)}
						/>
					</label>
				)}
				<label className="block space-y-1" htmlFor={id + "-pin"}>
					<span>
						<Message
							text={configured ? "Vault PIN" : "Create a PIN (6–16 digits)"}
						/>
					</span>
					<Input
						id={id + "-pin"}
						type="password"
						inputMode="numeric"
						autoComplete="off"
						pattern="[0-9]{6,16}"
						required
						minLength={6}
						maxLength={16}
						value={pin}
						onChange={(e) => setPin(e.target.value)}
					/>
				</label>
				<Button type="submit" disabled={busy}>
					<Message text={configured ? "Unlock provider" : "Save connection"} />
				</Button>
			</form>
			{configured && (
				<p role="status">
					<Message text="ElevenLabs connection saved" />
				</p>
			)}
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			<a
				href="https://elevenlabs.io/app/settings/api-keys"
				target="_blank"
				rel="noreferrer"
				className="underline"
			>
				<Message text="API keys" />
			</a>
		</div>
	);
}
const emptyDraft = (kind: AudioDraft["kind"] = "speech"): AudioDraft => ({
	id: crypto.randomUUID(),
	version: 1,
	title: "Audio",
	kind,
	modelId:
		kind === "speech"
			? "eleven_multilingual_v2"
			: kind === "dialogue"
				? "eleven_v3"
				: kind === "music"
					? "music_v1"
					: "eleven_text_to_sound_v2",
	text: "",
	voiceId: null,
	durationSeconds: null,
	instrumental: false,
	dialogue: [],
});

export function DirectorAudioPanel() {
	const editor = useEditor(),
		{ t } = useInterfaceLanguage();
	const projectId =
		useEditorProject((e) => e.project.getActiveOrNull()?.metadata.id) ?? "";
	return (
		<AudioProjectPanel
			key={
				(typeof window !== "undefined" ? window.__opencutAccountId : "") +
				":" +
				projectId
			}
			editor={editor}
			projectId={projectId}
			t={t}
		/>
	);
}
function AudioProjectPanel({
	editor,
	projectId,
	t,
}: {
	editor: EditorCore;
	projectId: string;
	t: (message: string) => string;
}) {
	const formId = useId();
	const identity = useRef({ accountId: window.__opencutAccountId, projectId });
	const current = useCallback(
		() =>
			identity.current.accountId === window.__opencutAccountId &&
			editor.project.getActiveOrNull()?.metadata.id === projectId,
		[editor, projectId],
	);
	const draftsJson = useEditorHistory((currentEditor) => {
		try {
			return audioDraftsSnapshot(readAudioDrafts(currentEditor).drafts);
		} catch {
			return audioDraftsSnapshot([]);
		}
	});
	const drafts = useMemo(
		() => audioDraftSchema.array().parse(JSON.parse(draftsJson)),
		[draftsJson],
	);
	const [draft, setDraft] = useState<AudioDraft>(() => emptyDraft()),
		[baseVersion, setBaseVersion] = useState<number | null>(null);
	const [jobs, setJobs] = useState<AudioJob[]>([]),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false),
		[pin, setPin] = useState("");
	const [catalog, setCatalog] = useState<{
		voices: { voice_id: string; name: string }[];
		models: {
			model_id: string;
			name: string;
			can_do_text_to_speech?: boolean;
		}[];
	}>({ voices: [], models: [] });
	const pending = useRef<{ fingerprint: string; operationId: string } | null>(
		null,
	);
	const controllers = useRef(new Set<AbortController>());
	const refresh = useCallback(
		async (signal?: AbortSignal) => {
			const s = await audioApi<AudioStatus>({ projectId, signal });
			if (current()) setJobs(s.jobs);
		},
		[projectId, current],
	);
	useEffect(() => {
		const c = new AbortController();
		const pendingControllers = controllers.current;
		let polling = false;
		const poll = async () => {
			if (polling) return;
			polling = true;
			try {
				await refresh(c.signal);
			} catch (e) {
				if (!c.signal.aborted && current())
					setError(e instanceof Error ? e.message : "Audio status unavailable");
			} finally {
				polling = false;
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), 4000);
		return () => {
			c.abort();
			clearInterval(timer);
			for (const op of pendingControllers) op.abort();
		};
	}, [refresh, current]);
	async function run(action: (signal: AbortSignal) => Promise<void>) {
		if (busy || !current()) return;
		const c = new AbortController();
		controllers.current.add(c);
		setBusy(true);
		setError("");
		try {
			await action(c.signal);
		} catch (e) {
			if (!c.signal.aborted && current())
				setError(e instanceof Error ? e.message : "Audio operation failed");
		} finally {
			controllers.current.delete(c);
			if (current()) setBusy(false);
		}
	}
	function saveDraft() {
		const old = readAudioDrafts(editor).drafts.find((d) => d.id === draft.id);
		if (baseVersion !== null && old?.version !== baseVersion)
			throw new Error("This audio draft changed; reload it before saving");
		const original = audioDraftSchema.parse(draft);
		if (old && JSON.stringify(old) === JSON.stringify(original)) return old;
		const checked = audioDraftSchema.parse({
			...original,
			version: (baseVersion ?? 0) + 1,
		});
		editAudioDraft({
			editor,
			draft: checked,
			expectedDraftVersion: baseVersion,
		});
		setDraft(checked);
		setBaseVersion(checked.version);
		return checked;
	}
	async function prepare(signal: AbortSignal) {
		const checked = saveDraft();
		const fingerprint = JSON.stringify(checked);
		if (pending.current?.fingerprint !== fingerprint)
			pending.current = { fingerprint, operationId: crypto.randomUUID() };
		await audioApi({
			projectId,
			action: "prepare",
			signal,
			data: { draft: checked, operationId: pending.current.operationId },
		});
		await refresh(signal);
	}
	async function importAudio({
		job,
		signal,
	}: {
		job: AudioJob;
		signal: AbortSignal;
	}) {
		if (!job.output) return;
		const id = "elevenlabs-" + job.id;
		if (editor.media.getAssets().some((a) => a.id === id)) return;
		const r = await fetch(audioFileUrl({ projectId, id: job.output.id }), {
			signal,
			credentials: "same-origin",
		});
		if (!r.ok) throw new Error("Audio download failed");
		const file = new File([await r.blob()], job.output.name, {
			type: job.output.mime,
		});
		const assets = await processMediaAssets({ files: [file] });
		if (!current() || signal.aborted) return;
		if (!assets[0]) throw new Error("Could not decode generated audio");
		await editor.media.addMediaAsset({
			projectId,
			asset: { ...assets[0], id },
		});
	}
	const stale =
		baseVersion !== null &&
		drafts.find((d) => d.id === draft.id)?.version !== baseVersion;
	const patch = (change: Partial<AudioDraft>) =>
		setDraft((d) => ({ ...d, ...change }));
	return (
		<section
			aria-label={t("Director audio production")}
			className="space-y-4 p-3 text-sm"
		>
			<div>
				<h2 className="font-semibold">ElevenLabs</h2>
				<p className="text-xs text-muted-foreground">
					<Message text="Create speech, dialogue, sound effects and music. Review the exact request before entering your PIN." />
				</p>
			</div>
			<AgentSettingsSection title="ElevenLabs connection">
				<ElevenLabsConnectionSettings projectId={projectId} />
			</AgentSettingsSection>
			{error && (
				<p
					role="alert"
					className="rounded border border-destructive/30 p-2 text-destructive"
				>
					{error}
				</p>
			)}
			<label className="block">
				<Message text="Saved drafts" />
				<select
					aria-label={t("Saved drafts")}
					className="w-full rounded border bg-background p-2"
					value={baseVersion === null ? "" : draft.id}
					onChange={(e) => {
						const d = drafts.find((d) => d.id === e.target.value);
						setDraft(d ?? emptyDraft());
						setBaseVersion(d?.version ?? null);
						pending.current = null;
					}}
				>
					<option value="">{t("New audio draft")}</option>
					{drafts.map((d) => (
						<option key={d.id} value={d.id}>
							{d.title} · v{d.version}
						</option>
					))}
				</select>
			</label>
			<label className="block" htmlFor={formId + "-title"}>
				<Message text="Title" />
				<Input
					id={formId + "-title"}
					value={draft.title}
					maxLength={300}
					onChange={(e) => patch({ title: e.target.value })}
				/>
			</label>
			<label className="block">
				<Message text="Audio type" />
				<select
					aria-label={t("Audio type")}
					className="w-full rounded border bg-background p-2"
					value={draft.kind}
					onChange={(e) => {
						const next = emptyDraft(
							audioDraftSchema.shape.kind.parse(e.target.value),
						);
						patch({
							kind: next.kind,
							modelId: next.modelId,
							durationSeconds: null,
						});
					}}
				>
					{(["speech", "dialogue", "sound", "music"] as const).map((k) => (
						<option key={k} value={k}>
							{t(
								k === "speech"
									? "Speech"
									: k === "dialogue"
										? "Dialogue"
										: k === "sound"
											? "Sound effects"
											: "Music",
							)}
						</option>
					))}
				</select>
			</label>
			<Button
				variant="outline"
				disabled={busy}
				onClick={() =>
					void run(async (signal) => {
						const c = await audioApi<typeof catalog>({
							projectId,
							catalog: true,
							signal,
						});
						if (current()) setCatalog(c);
					})
				}
			>
				<Message text="Load voices and models" />
			</Button>
			<label className="block">
				<Message text="Model" />
				<Input
					list="elevenlabs-audio-models"
					value={draft.modelId}
					maxLength={120}
					onChange={(e) => patch({ modelId: e.target.value })}
				/>
				<datalist id="elevenlabs-audio-models">
					{catalog.models
						.filter((m) => draft.kind !== "speech" || m.can_do_text_to_speech)
						.map((m) => (
							<option key={m.model_id} value={m.model_id}>
								{m.name}
							</option>
						))}
				</datalist>
			</label>
			{draft.kind === "speech" && (
				<label className="block" htmlFor={formId + "-voice"}>
					<Message text="Voice ID" />
					<Input
						id={formId + "-voice"}
						list="elevenlabs-audio-voices"
						value={draft.voiceId ?? ""}
						onChange={(e) => patch({ voiceId: e.target.value })}
					/>
				</label>
			)}
			<datalist id="elevenlabs-audio-voices">
				{catalog.voices.map((v) => (
					<option key={v.voice_id} value={v.voice_id}>
						{v.name}
					</option>
				))}
			</datalist>
			{draft.kind === "dialogue" ? (
				<div className="space-y-2">
					{draft.dialogue.map((line, index) => (
						<div key={index} className="space-y-1 rounded border p-2">
							<Input
								aria-label={t("Voice ID")}
								list="elevenlabs-audio-voices"
								value={line.voiceId}
								onChange={(e) =>
									patch({
										dialogue: draft.dialogue.map((l, i) =>
											i === index ? { ...l, voiceId: e.target.value } : l,
										),
									})
								}
							/>
							<Textarea
								aria-label={t("Dialogue text")}
								dir="auto"
								value={line.text}
								onChange={(e) =>
									patch({
										dialogue: draft.dialogue.map((l, i) =>
											i === index ? { ...l, text: e.target.value } : l,
										),
									})
								}
							/>
							<Button
								variant="ghost"
								onClick={() =>
									patch({
										dialogue: draft.dialogue.filter((_, i) => i !== index),
									})
								}
							>
								<Message text="Remove" />
							</Button>
						</div>
					))}
					<Button
						disabled={draft.dialogue.length >= 50}
						variant="outline"
						onClick={() =>
							patch({
								dialogue: [...draft.dialogue, { text: "", voiceId: "" }],
							})
						}
					>
						<Message text="Add dialogue line" />
					</Button>
				</div>
			) : (
				<label className="block" htmlFor={formId + "-text"}>
					<Message
						text={
							draft.kind === "speech" ? "Speech text" : "Describe the audio"
						}
					/>
					<Textarea
						id={formId + "-text"}
						dir="auto"
						className="min-h-28"
						value={draft.text}
						maxLength={12000}
						onChange={(e) => patch({ text: e.target.value })}
					/>
				</label>
			)}
			{(draft.kind === "sound" || draft.kind === "music") && (
				<label className="block" htmlFor={formId + "-duration"}>
					<Message text="Duration seconds" />
					<Input
						id={formId + "-duration"}
						type="number"
						min={draft.kind === "sound" ? 0.5 : 3}
						max={draft.kind === "sound" ? 30 : 600}
						step={0.5}
						value={draft.durationSeconds ?? ""}
						onChange={(e) =>
							patch({
								durationSeconds: e.target.value ? Number(e.target.value) : null,
							})
						}
					/>
				</label>
			)}
			{draft.kind === "music" && (
				<label className="flex gap-2">
					<input
						type="checkbox"
						checked={draft.instrumental}
						onChange={(e) => patch({ instrumental: e.target.checked })}
					/>
					<Message text="Instrumental only" />
				</label>
			)}
			{stale && (
				<p role="alert">
					<Message text="This draft changed. Select it again to load the latest version." />
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					variant="outline"
					disabled={busy || stale}
					onClick={() =>
						void run(async () => {
							saveDraft();
						})
					}
				>
					<Message text="Save draft" />
				</Button>
				<Button disabled={busy || stale} onClick={() => void run(prepare)}>
					<Message text="Prepare audio for approval" />
				</Button>
			</div>
			<div className="space-y-3">
				{jobs.map((job) => (
					<article key={job.id} className="space-y-2 rounded-lg border p-3">
						<div className="flex justify-between gap-2">
							<strong>{job.draft.title}</strong>
							<span>{t(job.status)}</span>
						</div>
						<p className="text-xs text-muted-foreground">
							{job.draft.kind} · {job.draft.modelId} · v{job.draft.version}
						</p>
						<p className="whitespace-pre-wrap" dir="auto">
							{job.draft.kind === "dialogue"
								? job.draft.dialogue
										.map((l) => `${l.voiceId}: ${l.text}`)
										.join("\n")
								: job.draft.text}
						</p>
						{job.message && (
							<p role="status" className="text-xs">
								{job.message}
							</p>
						)}
						{job.status === "review" && (
							<>
								<p className="text-xs">
									<Message text="This sends the text to ElevenLabs and charges your connected account. Enter your PIN to approve this exact request." />
								</p>
								<Input
									type="password"
									aria-label={t("Approval PIN")}
									autoComplete="off"
									inputMode="numeric"
									maxLength={16}
									value={pin}
									onChange={(e) => setPin(e.target.value)}
								/>
								<div className="flex gap-2">
									<Button
										disabled={busy || !/^\d{6,16}$/.test(pin)}
										onClick={() =>
											void run(async (signal) => {
												const approvalPin = pin;
												setPin("");
												await audioApi({
													projectId,
													action: "approve",
													signal,
													data: {
														id: job.id,
														digest: job.digest,
														pin: approvalPin,
														confirmed: true,
													},
												});
												await refresh(signal);
											})
										}
									>
										<Message text="Approve and generate" />
									</Button>
									<Button
										variant="ghost"
										disabled={busy}
										onClick={() =>
											void run(async (signal) => {
												await audioApi({
													projectId,
													action: "cancel",
													signal,
													data: { id: job.id },
												});
												await refresh(signal);
											})
										}
									>
										<Message text="Cancel" />
									</Button>
								</div>
							</>
						)}
						{job.output && (
							<>
								<audio
									controls
									src={audioFileUrl({ projectId, id: job.output.id })}
									aria-label={job.draft.title}
								>
									<track kind="captions" />
								</audio>
								<Button
									disabled={busy}
									onClick={() =>
										void run((signal) => importAudio({ job, signal }))
									}
								>
									<Message text="Import to Assets" />
								</Button>
							</>
						)}
					</article>
				))}
			</div>
		</section>
	);
}
