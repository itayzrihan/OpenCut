"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Code2, Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEditor } from "@/editor/use-editor";
import type { ProceduralAudioElement } from "@/timeline";
import type { EarshotSpec } from "../types";
import { createEarshotSourceCode, getEarshotSound } from "../catalog";
import { previewEarshotSound, resolveEarshotBuffer } from "../audio";

export function EarshotProperties({
	element,
	trackId,
}: {
	element: ProceduralAudioElement;
	trackId: string;
}) {
	const editor = useEditor();
	const controlId = useId();
	const [draft, setDraft] = useState<EarshotSpec>(element.procedural);
	const [parameters, setParameters] = useState(
		JSON.stringify(element.procedural.parameters ?? {}, null, 2),
	);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	const [reference, setReference] = useState("");
	const active = useRef<AbortController | null>(null);
	useEffect(() => {
		active.current?.abort();
		setDraft(element.procedural);
		setParameters(JSON.stringify(element.procedural.parameters ?? {}, null, 2));
		setBusy(false);
	}, [element.id, element.procedural]);
	useEffect(() => () => active.current?.abort(), []);
	const sound = getEarshotSound(draft.presetId);
	const update = (patch: Partial<EarshotSpec>) =>
		setDraft((value) => ({ ...value, ...patch }));
	const loadReference = async () => {
		if (!sound) return;
		active.current?.abort();
		const controller = new AbortController();
		active.current = controller;
		setBusy(true);
		try {
			let code = "",
				offset: number | null = 0;
			while (offset !== null) {
				const response: Response = await fetch(
					`/api/earshot/repository?operation=read&path=${encodeURIComponent(sound.sourcePath)}&offset=${offset}`,
					{ signal: controller.signal },
				);
				const result: {
					encoding: string;
					error?: string;
					content: string;
					nextOffset: number | null;
				} = await response.json();
				if (!response.ok || result.encoding !== "utf8")
					throw new Error(result.error ?? "Could not read this recipe");
				code += result.content;
				offset = result.nextOffset;
			}
			controller.signal.throwIfAborted();
			setReference(code);
			setStatus("Original source loaded below for reference.");
		} catch (error) {
			if (!controller.signal.aborted)
				setStatus(
					error instanceof Error ? error.message : "Recipe read failed",
				);
		} finally {
			if (active.current === controller) setBusy(false);
		}
	};
	const run = async (apply: boolean) => {
		active.current?.abort();
		const controller = new AbortController();
		active.current = controller;
		setBusy(true);
		setStatus("Synthesizing code sound…");
		const projectId = editor.project.getActive().metadata.id;
		const sceneId = editor.scenes.getActiveScene().id;
		const revision = editor.command.getStateRevision();
		try {
			const spec: EarshotSpec = {
				...draft,
				parameters: JSON.parse(parameters),
				sourceCode: draft.sourceCode?.trim() || undefined,
			};
			if (apply) {
				const context = new OfflineAudioContext(2, 1, 48000);
				await resolveEarshotBuffer({
					spec,
					context,
					signal: controller.signal,
				});
				controller.signal.throwIfAborted();
				if (
					editor.project.getActive().metadata.id !== projectId ||
					editor.scenes.getActiveScene().id !== sceneId ||
					editor.command.getStateRevision() !== revision
				)
					throw new Error(
						"The timeline changed while checking the sound. Apply again to the current edit.",
					);
				editor.command.setProceduralAudio([
					{ trackId, elementId: element.id, procedural: spec },
				]);
				setStatus("Code sound updated. Undo restores the previous recipe.");
			} else {
				await previewEarshotSound({ spec, signal: controller.signal });
				setStatus("Playing preview. Apply changes to update the clip.");
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				const message =
					error instanceof Error ? error.message : "Code sound failed";
				setStatus(message);
				toast.error(message);
			}
		} finally {
			if (active.current === controller) setBusy(false);
		}
	};
	return (
		<div className="space-y-4 p-4" data-earshot-properties>
			<div>
				<h3 className="flex items-center gap-2 text-sm font-medium">
					<Code2 className="size-4 text-violet-400" /> Earshot · Editable code
				</h3>
				<p className="text-muted-foreground mt-1 text-xs">{draft.presetId}</p>
			</div>
			<div className="grid grid-cols-2 gap-3">
				<label htmlFor={`${controlId}-duration`} className="space-y-1 text-xs">
					Duration (s)
					<Input
						id={`${controlId}-duration`}
						aria-label="Code sound duration"
						type="number"
						min="0.02"
						max="30"
						step="0.01"
						value={draft.duration}
						onChange={(e) => update({ duration: Number(e.target.value) })}
					/>
				</label>
				<label htmlFor={`${controlId}-seed`} className="space-y-1 text-xs">
					Seed
					<Input
						id={`${controlId}-seed`}
						aria-label="Code sound seed"
						type="number"
						min="0"
						max="4294967295"
						step="1"
						value={draft.seed}
						onChange={(e) => update({ seed: Number(e.target.value) })}
					/>
				</label>
				<label htmlFor={`${controlId}-apex`} className="space-y-1 text-xs">
					Peak time (s)
					<Input
						id={`${controlId}-apex`}
						aria-label="Code sound apex"
						type="number"
						min="0"
						max={draft.duration}
						step="0.01"
						value={draft.apex ?? ""}
						placeholder="Original"
						onChange={(e) =>
							update({
								apex: e.target.value ? Number(e.target.value) : undefined,
							})
						}
					/>
				</label>
				<label htmlFor={`${controlId}-pitch`} className="space-y-1 text-xs">
					Pitch (note / Hz)
					<Input
						id={`${controlId}-pitch`}
						aria-label="Code sound pitch"
						value={draft.pitch ?? ""}
						placeholder={
							sound?.pitchable ? "Original · e.g. A4" : "Noise sound"
						}
						disabled={!sound?.pitchable && !draft.sourceCode}
						onChange={(e) =>
							update({
								pitch: !e.target.value
									? undefined
									: /^\d+(\.\d+)?$/.test(e.target.value)
										? Number(e.target.value)
										: e.target.value,
							})
						}
					/>
				</label>
			</div>
			<fieldset className="space-y-2 rounded border p-3">
				<legend className="px-1 text-xs">Echo</legend>
				<label className="flex items-center gap-2 text-xs">
					<input
						type="checkbox"
						checked={!!draft.echo}
						onChange={(e) =>
							update({
								echo: e.target.checked
									? { delay: 0.18, feedback: 0.25, mix: 0.2 }
									: undefined,
							})
						}
					/>{" "}
					Enable echo
				</label>
				{draft.echo && (
					<div className="grid grid-cols-3 gap-2">
						{(
							[
								["delay", "Delay (s)", 2],
								["feedback", "Feedback", 0.9],
								["mix", "Mix", 1],
							] as const
						).map(([key, label, max]) => (
							<label key={key} className="text-xs">
								{label}
								<Input
									aria-label={`Echo ${label}`}
									type="number"
									min={key === "delay" ? "0.005" : "0"}
									max={max}
									step="0.01"
									value={draft.echo![key]}
									onChange={(e) =>
										update({
											echo: { ...draft.echo!, [key]: Number(e.target.value) },
										})
									}
								/>
							</label>
						))}
					</div>
				)}
				<p className="text-muted-foreground text-[10px]">
					Echo stays inside the clip duration. Extend the duration for a longer
					tail.
				</p>
			</fieldset>
			<details>
				<summary className="cursor-pointer text-xs font-medium">
					Recipe parameters
				</summary>
				<details className="mt-2">
					<summary className="text-muted-foreground text-xs">
						Original parameter values
					</summary>
					<pre className="max-h-48 overflow-auto text-[10px]">
						{JSON.stringify(sound?.parameters ?? {}, null, 2)}
					</pre>
				</details>
				<textarea
					aria-label="Earshot recipe parameters"
					spellCheck={false}
					className="bg-input mt-2 min-h-32 w-full rounded border p-2 font-mono text-xs"
					value={parameters}
					onChange={(e) => setParameters(e.target.value)}
				/>
				<p className="text-muted-foreground text-[10px]">
					Numeric overrides for the recipe’s parameters. Unspecified values keep
					the original sound.
				</p>
			</details>
			<details>
				<summary className="cursor-pointer text-xs font-medium">
					Edit Python recipe
				</summary>
				<Button
					variant="outline"
					size="sm"
					className="mt-2"
					disabled={busy}
					onClick={() => {
						update({ sourceCode: createEarshotSourceCode(draft.presetId) });
						setStatus("Editable recipe loaded. Preview before applying.");
					}}
				>
					Customize this sound
				</Button>
				<p className="text-muted-foreground my-2 text-xs">
					Define render(params, r) and return mono or stereo NumPy samples at 48
					kHz. r is the seeded NumPy random generator. Earshot DSP modules are
					available. Leave empty to use the original bank recipe.
				</p>
				<textarea
					aria-label="Earshot Python recipe"
					spellCheck={false}
					maxLength={32768}
					className="bg-input min-h-64 w-full rounded border p-2 font-mono text-xs"
					value={draft.sourceCode ?? ""}
					placeholder="def render(params, r):\n    …"
					onChange={(e) => update({ sourceCode: e.target.value })}
				/>
				<details className="mt-2">
					<summary className="cursor-pointer text-xs">
						Upstream source reference
					</summary>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={() => void loadReference()}
					>
						Read {sound?.sourcePath}
					</Button>
					{reference && (
						<pre className="max-h-80 overflow-auto whitespace-pre text-[10px]">
							{reference}
						</pre>
					)}
				</details>
			</details>
			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={() => void run(false)}
				>
					<Play /> Preview
				</Button>
				<Button size="sm" disabled={busy} onClick={() => void run(true)}>
					{busy && <Loader2 className="animate-spin" />}Apply changes
				</Button>
				{busy && (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							active.current?.abort();
							setBusy(false);
							setStatus("Cancelled.");
						}}
					>
						Cancel
					</Button>
				)}
			</div>
			{status && (
				<p role="status" className="text-muted-foreground text-xs">
					{status}
				</p>
			)}
		</div>
	);
}
