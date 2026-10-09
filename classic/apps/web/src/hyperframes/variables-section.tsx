"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import {
	useEditor,
	useEditorProject,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import { loadCanonicalRuntime } from "@/core/load-canonical-runtime";
import type { HyperframesComposition, HyperframesVariable } from "./types";

export function HyperframesVariablesSection({
	assetId,
	elementId,
}: {
	assetId: string;
	elementId: string;
}) {
	const state = useEditorProject((core) => {
		const project = core.project.getActiveOrNull();
		return {
			projectId: project?.metadata.id,
			composition: project?.hyperframesCompositions?.[assetId],
		};
	});
	return state.projectId && state.composition ? (
		<VariablesInspector
			key={`${state.projectId}:${assetId}`}
			projectId={state.projectId}
			composition={state.composition}
			elementId={elementId}
		/>
	) : null;
}

function VariablesInspector({
	projectId,
	composition,
	elementId,
}: {
	projectId: string;
	composition: HyperframesComposition;
	elementId: string;
}) {
	const editor = useEditor();
	const sceneId = useEditorTimelineScenes(
		(core) => core.scenes.getActiveSceneOrNull()?.id,
	);
	const [declarations, setDeclarations] = useState<HyperframesVariable[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const operation = useRef<AbortController | null>(null);
	useEffect(
		() => () => operation.current?.abort(),
		[projectId, sceneId, elementId],
	);
	useEffect(() => {
		let active = true;
		void loadCanonicalRuntime()
			.then((runtime) => {
				try {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Canonical registry validates the declaration projection.
					const result = runtime.invokeSync(
						"hyperframes.variables.read",
						{ source: composition.source },
						undefined,
					) as { result: { data: { declarations: HyperframesVariable[] } } };
					if (active) setDeclarations(result.result.data.declarations);
				} finally {
					runtime.free();
				}
			})
			.catch((cause: unknown) => {
				if (active)
					setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			active = false;
			operation.current?.abort();
		};
	}, [composition.source]);
	const apply = async (values: Record<string, unknown>) => {
		if (!sceneId || operation.current) return;
		const controller = new AbortController();
		operation.current = controller;
		setBusy(true);
		setError(null);
		try {
			await editor.command.setHyperframesVariables({
				projectId,
				sceneId,
				elementId,
				source: composition.source,
				values,
				signal: controller.signal,
			});
		} catch (cause) {
			if (!controller.signal.aborted)
				setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (operation.current === controller) {
				operation.current = null;
				setBusy(false);
			}
		}
	};
	// Show variables declared by mounted files, including sub-compositions.
	const mounted = new Set([
		composition.source.entryFile,
		...(composition.runtimeManifest?.layers.flatMap((layer) =>
			layer.file ? [layer.file] : [],
		) ?? []),
	]);
	const visible = declarations.filter(
		(variable, index) =>
			mounted.has(variable.file) &&
			declarations.findIndex(
				(other) => other.id === variable.id && mounted.has(other.file),
			) === index,
	);
	if (!visible.length && !error) return null;
	return (
		<Section collapsible sectionKey="hyperframes-variables">
			<SectionHeader>
				<SectionTitle>Composition variables</SectionTitle>
			</SectionHeader>
			<SectionContent className="flex flex-col gap-3">
				<p className="text-muted-foreground text-xs">
					Customize this clip’s text and style. Shared variable names also
					update matching nested compositions.
				</p>
				{visible.map((variable) => (
					<VariableField
						key={`${variable.id}:${JSON.stringify(composition.source.variables?.[variable.id])}`}
						variable={variable}
						value={
							composition.source.variables?.[variable.id] ??
							variable.declaration.default
						}
						overridden={Object.hasOwn(
							composition.source.variables ?? {},
							variable.id,
						)}
						disabled={busy}
						onApply={(value) =>
							void apply({
								...composition.source.variables,
								[variable.id]: value,
							})
						}
						onReset={() => {
							const values = { ...composition.source.variables };
							delete values[variable.id];
							void apply(values);
						}}
					/>
				))}
				{busy && (
					<div
						className="flex items-center justify-between gap-2 text-xs"
						role="status"
					>
						<Loader2 className="size-3 animate-spin" />
						Checking the updated animation…
						<Button
							size="sm"
							variant="ghost"
							onClick={() => operation.current?.abort()}
						>
							Cancel
						</Button>
					</div>
				)}
				{error && (
					<p role="alert" className="text-destructive text-xs">
						{error}
					</p>
				)}
			</SectionContent>
		</Section>
	);
}

function VariableField({
	variable,
	value,
	overridden,
	disabled,
	onApply,
	onReset,
}: {
	variable: HyperframesVariable;
	value: unknown;
	overridden: boolean;
	disabled: boolean;
	onApply: (value: unknown) => void;
	onReset: () => void;
}) {
	const { declaration: d, id } = variable;
	const label = d.label || id;
	const structured =
		value && typeof value === "object" && !Array.isArray(value) ? value : null;
	const initial = String(
		structured && d.type === "image" && "url" in structured
			? structured.url
			: structured && d.type === "font" && "name" in structured
				? structured.name
				: (value ?? ""),
	);
	const initialFontSource = String(
		structured && "source" in structured ? structured.source : "",
	);
	const [draft, setDraft] = useState(initial);
	const [fontSource, setFontSource] = useState(initialFontSource);
	const changed = draft !== initial || fontSource !== initialFontSource;
	const [error, setError] = useState<string | null>(null);
	const submit = () => {
		try {
			const next: unknown =
				d.type === "image" && structured
					? { ...structured, url: draft }
					: d.type === "font" && (structured || fontSource)
						? { ...structured, name: draft, source: fontSource }
						: d.type === "number"
							? Number(draft)
							: draft;
			if (
				d.type === "number" &&
				(draft.trim() === "" || !Number.isFinite(next))
			)
				throw new Error("Enter a finite number.");
			setError(null);
			onApply(next);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	const common = {
		disabled,
		"aria-label": `Variable: ${label}`,
		className:
			"border-input bg-background w-full rounded border px-2 py-1.5 text-xs",
	};
	return (
		<div className="flex flex-col gap-1.5 border-b pb-3 last:border-b-0">
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs font-medium">{label}</span>
				<Button
					size="sm"
					variant="ghost"
					disabled={disabled || !overridden}
					aria-label={`Reset variable: ${label}`}
					onClick={onReset}
				>
					Reset
				</Button>
			</div>
			{d.type === "boolean" ? (
				<label className="flex items-center gap-2 text-xs">
					<input
						type="checkbox"
						aria-label={`Variable: ${label}`}
						checked={value === true}
						disabled={disabled}
						onChange={(event) => onApply(event.target.checked)}
					/>
					Enabled
				</label>
			) : d.type === "enum" ? (
				<select
					{...common}
					value={String(value ?? "")}
					onChange={(event) => onApply(event.target.value)}
				>
					{d.options?.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label || option.value}
						</option>
					))}
				</select>
			) : (
				<>
					<input
						{...common}
						type={d.type === "number" ? "number" : "text"}
						value={draft}
						min={d.min}
						max={d.max}
						step={d.step ?? "any"}
						maxLength={d.maxLength}
						placeholder={d.placeholder}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && changed) submit();
						}}
					/>
					{d.type === "font" && (
						<input
							{...common}
							aria-label={`Font source: ${label}`}
							value={fontSource}
							placeholder="Font file or URL (optional)"
							onChange={(event) => setFontSource(event.target.value)}
						/>
					)}
					<Button
						size="sm"
						variant="outline"
						disabled={disabled || !changed}
						aria-label={`Apply variable: ${label}`}
						onClick={submit}
					>
						Apply
					</Button>
				</>
			)}
			{d.description && (
				<p className="text-muted-foreground text-xs">{d.description}</p>
			)}
			{error && (
				<p role="alert" className="text-destructive text-xs">
					{error}
				</p>
			)}
		</div>
	);
}
