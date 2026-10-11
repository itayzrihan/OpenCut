"use client";

import { useEffect, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type {
	ExampleManifest,
	ExampleSearch,
	ExampleSourcePage,
} from "./example-types";
import { offerEditingAgentDraft } from "@/editor-agent/draft";
import { CatalogLivePreview } from "./catalog-live-preview";
import type { ExampleHit } from "./example-types";
import { importHyperframesExample } from "./import-example";

/** Disposable projections of the canonical catalog; no second library store. */
export function HyperframesExamplesLibrary({
	projectId,
	onClose,
	presentation = "dialog",
}: {
	projectId: string;
	onClose: () => void;
	presentation?: "dialog" | "page" | "panel";
}) {
	const editor = useEditor();
	const isPanel = presentation === "panel";
	const [hovered, setHovered] = useState<ExampleHit | null>(null);
	const [query, setQuery] = useState("");
	const [kind, setKind] = useState<"" | "block" | "component" | "example">("");
	const [verifiedOnly, setVerifiedOnly] = useState(false);
	const [semantic, setSemantic] = useState(false);
	const [offset, setOffset] = useState(0);
	const [search, setSearch] = useState<ExampleSearch | null>(null);
	const [selected, setSelected] = useState<ExampleManifest | null>(null);
	const [page, setPage] = useState<ExampleSourcePage | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [remixBrief, setRemixBrief] = useState("");
	const [importing, setImporting] = useState(false);
	const [progress, setProgress] = useState("");
	const sourceRead = useRef<AbortController | null>(null);
	const selection = useRef(0);
	useEffect(
		() => () => {
			selection.current++;
			sourceRead.current?.abort();
		},
		[],
	);
	useEffect(() => {
		let current = true;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			void editor.command
				.searchHyperframesExamples({
					projectId,
					query,
					semantic,
					signal: controller.signal,
					kind: kind || undefined,
					verifiedOnly,
					offset,
				})
				.then(
					(result) => {
						if (current) {
							setSearch(result);
							setError("");
						}
					},
					(cause: unknown) => {
						if (current) setError(String(cause));
					},
				);
		}, 180);
		return () => {
			current = false;
			clearTimeout(timer);
			controller.abort();
		};
	}, [editor, projectId, query, kind, verifiedOnly, offset, semantic]);
	const choose = async (id: string) => {
		if (importing) return;
		if (!search) return;
		const generation = ++selection.current;
		sourceRead.current?.abort();
		setBusy(false);
		setPage(null);
		setSelected(null);
		setError("");
		try {
			const result = await editor.command.readHyperframesExample({
				projectId,
				id,
				upstreamCommit: search.upstreamCommit,
			});
			if (generation === selection.current) setSelected(result);
		} catch (cause) {
			if (generation === selection.current) setError(String(cause));
		}
	};
	const readSource = async ({
		filePath,
		sourceOffset = 0,
	}: {
		filePath: string;
		sourceOffset?: number;
	}) => {
		if (!selected || busy) return;
		const generation = selection.current;
		const controller = new AbortController();
		sourceRead.current = controller;
		setBusy(true);
		setError("");
		try {
			const expectedSha256 = filePath.startsWith("@prepared/")
				? selected.item.prepared?.files.find(
						(file) => `@prepared/${file.path}` === filePath,
					)?.sha256
				: undefined;
			const result = await editor.command.readHyperframesExampleSource({
				projectId,
				id: selected.item.id,
				upstreamCommit: selected.upstreamCommit,
				filePath,
				expectedSha256,
				offset: sourceOffset,
				signal: controller.signal,
			});
			if (!controller.signal.aborted && generation === selection.current)
				setPage(result);
		} catch (cause) {
			if (!controller.signal.aborted && generation === selection.current)
				setError(String(cause));
		} finally {
			if (sourceRead.current === controller) {
				sourceRead.current = null;
				setBusy(false);
			}
		}
	};
	const addPrepared = async () => {
		if (!selected?.item.prepared || busy || importing) return;
		const controller = new AbortController();
		sourceRead.current = controller;
		setImporting(true);
		setBusy(true);
		setError("");
		setProgress("Reading the prepared package…");
		try {
			await importHyperframesExample({
				editor,
				projectId,
				id: selected.item.id,
				upstreamCommit: selected.upstreamCommit,
				signal: controller.signal,
				onProgress: ({ phase, completed, total }) =>
					setProgress(`${phase}: ${completed}/${total}`),
			});
			onClose();
		} catch (cause) {
			if (!controller.signal.aborted) setError(String(cause));
		} finally {
			if (sourceRead.current === controller) sourceRead.current = null;
			setBusy(false);
			setImporting(false);
			setProgress("");
		}
	};
	const promptText = selected
		? (selected.item.prompt.text ??
			`Use the HyperFrames ${selected.item.kind} “${selected.item.title}” (${selected.item.id}). ${selected.item.description}\n\nRead its pinned source: ${selected.item.sourceUrl}. Adapt its content and colors to my project while preserving the original motion.`)
		: "";
	const content = (
		<>
			<header className="flex shrink-0 items-start justify-between gap-4 border-b p-3">
				<div>
					<h1 className="text-sm font-semibold">
						Catalog · HyperFrames + OpenCut
					</h1>
					<p className="text-sm text-muted-foreground">
						Hover to play live code. Open a card for its prompt, source and
						timeline import.
					</p>
				</div>
				{presentation === "page" && (
					<Button variant="outline" onClick={onClose}>
						Back to editor
					</Button>
				)}
			</header>
			<div className="min-h-0 flex-1 overflow-auto space-y-3 p-3">
				{(!isPanel || !selected) && (
					<>
						<div className="flex flex-wrap items-center gap-3">
							<input
								className={
									isPanel
										? "w-full min-w-0 basis-full rounded border bg-transparent p-2"
										: "min-w-0 flex-1 rounded border bg-transparent p-2"
								}
								aria-label="Search HyperFrames examples"
								placeholder="Search titles, effects or styles…"
								value={query}
								onChange={(event) => {
									setQuery(event.target.value);
									setOffset(0);
								}}
							/>
							<select
								className="rounded border bg-background p-2"
								aria-label="Reference type"
								value={kind}
								onChange={(event) => {
									const value = event.target.value;
									if (
										value === "" ||
										value === "block" ||
										value === "component" ||
										value === "example"
									) {
										setKind(value);
										setOffset(0);
									}
								}}
							>
								<option value="">All types</option>
								<option value="block">Blocks</option>
								<option value="component">Components</option>
								<option value="example">Examples</option>
							</select>
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={verifiedOnly}
									onChange={(event) => {
										setVerifiedOnly(event.target.checked);
										setOffset(0);
									}}
								/>
								Verified only
							</label>
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									aria-label="Local semantic search"
									checked={semantic}
									onChange={(event) => {
										setSemantic(event.target.checked);
										setOffset(0);
									}}
								/>
								Semantic search · local model (33 MB once)
							</label>
						</div>
						<p className="text-xs text-muted-foreground">
							{search
								? `${search.totalMatches} matches · ${search.totalCatalogItems} captured · ${search.totalVerified} verified local packages`
								: "Loading references…"}{" "}
							·{" "}
							{search?.searchMode === "semanticLocalBge"
								? `Semantic search · ${search.normalizedQuery}`
								: "Keyword search with Hebrew aliases."}
							{search?.fallbackReason && (
								<span role="status">
									{" "}
									Semantic search unavailable: {search.fallbackReason}
								</span>
							)}
						</p>
					</>
				)}
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{progress && (
					<p role="status" className="text-sm">
						{progress}
					</p>
				)}
				<div
					className={
						isPanel
							? "min-h-0 space-y-3"
							: "grid min-h-0 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)]"
					}
				>
					{(!isPanel || !selected) && (
						<div className="min-w-0 space-y-3">
							<div
								className={
									isPanel
										? "grid grid-cols-[repeat(auto-fit,minmax(min(100%,140px),1fr))] gap-2"
										: "grid grid-cols-2 gap-3 xl:grid-cols-3"
								}
							>
								{search?.items.map((item) => (
									<div
										key={item.id}
										className="relative min-w-0"
										data-catalog-card={item.id}
									>
										<button
											type="button"
											aria-pressed={selected?.item.id === item.id}
											className="group w-full overflow-hidden rounded-lg border text-left transition-colors hover:bg-accent hover:border-foreground/40 aria-pressed:border-foreground aria-pressed:bg-accent"
											onPointerEnter={() => setHovered(item)}
											onPointerLeave={() => setHovered(null)}
											onFocus={() => setHovered(item)}
											onBlur={() => setHovered(null)}
											onClick={() => void choose(item.id)}
										>
											<span className="flex aspect-video items-center justify-center overflow-hidden bg-gradient-to-br from-muted to-background">
												{item.posterUrl ? (
													// eslint-disable-next-line @next/next/no-img-element -- Optional upstream poster artwork; live source is loaded only on hover.
													<img
														src={item.posterUrl}
														alt=""
														loading="lazy"
														onError={(event) => {
															event.currentTarget.style.display = "none";
														}}
														className="h-full w-full object-contain"
													/>
												) : (
													<span className="px-4 text-center text-sm text-muted-foreground">
														{item.title}
													</span>
												)}
											</span>
											<span className="block px-3 pt-3 text-sm font-medium">
												{item.title}
											</span>
											<span className="block px-3 pb-3 pt-1 text-xs text-muted-foreground">
												{item.kind} ·{" "}
												{item.verified
													? "Verified"
													: item.reviewStatus === "excluded"
														? "Excluded after review"
														: "Captured — validation pending"}
											</span>
										</button>
										{isPanel && hovered?.id === item.id && (
											<div className="pointer-events-none absolute inset-x-px top-px aspect-video overflow-hidden rounded-t-lg">
												<CatalogLivePreview
													key={`${search.upstreamCommit}:${item.id}`}
													id={item.id}
													title={item.title}
													upstreamCommit={search.upstreamCommit}
												/>
											</div>
										)}
									</div>
								))}
							</div>
							{search?.totalMatches === 0 && (
								<p className="text-sm text-muted-foreground">
									No matching references. Try another term or include captured
									items.
								</p>
							)}
							<div className="flex gap-2">
								<Button
									variant="outline"
									size="sm"
									disabled={offset === 0}
									onClick={() => setOffset(Math.max(0, offset - 20))}
								>
									Previous
								</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={search?.nextOffset == null}
									onClick={() => {
										if (search?.nextOffset != null)
											setOffset(search.nextOffset);
									}}
								>
									Next
								</Button>
							</div>
						</div>
					)}
					{(!isPanel || selected) && (
						<aside
							className={
								isPanel
									? "min-w-0 space-y-3 break-words"
									: "order-first min-w-0 space-y-4 lg:order-last lg:sticky lg:top-0 lg:self-start"
							}
						>
							{isPanel && (
								<Button
									variant="outline"
									size="sm"
									onClick={() => {
										selection.current++;
										sourceRead.current?.abort();
										setSelected(null);
										setHovered(null);
										setPage(null);
										setBusy(false);
									}}
									disabled={importing}
								>
									Back to catalog
								</Button>
							)}
							{search && ((!isPanel && hovered) || selected) ? (
								<CatalogLivePreview
									key={`${search.upstreamCommit}:${((!isPanel && hovered) || selected!.item).id}`}
									id={((!isPanel && hovered) || selected!.item).id}
									title={((!isPanel && hovered) || selected!.item).title}
									upstreamCommit={search.upstreamCommit}
								/>
							) : (
								<div className="flex aspect-video items-center justify-center rounded-lg border bg-muted text-sm text-muted-foreground">
									Hover over a card to preview its live code
								</div>
							)}
							<p className="text-xs text-muted-foreground">
								Live HTML preview · silent · no video render required
							</p>
							{selected ? (
								<div
									className={
										isPanel
											? "min-w-0 space-y-3"
											: "max-h-[50vh] min-w-0 space-y-3 overflow-auto"
									}
								>
									<h3 className="font-medium">{selected.item.title}</h3>
									<p className="text-sm">{selected.item.description}</p>
									<a
										className="text-sm underline"
										href={selected.item.sourceUrl}
										target="_blank"
										rel="noreferrer"
									>
										View pinned upstream source
									</a>
									<p className="text-xs text-muted-foreground">
										Validation: {selected.item.verification.status}.{" "}
										{selected.item.verification.reviewNote}{" "}
										{selected.item.verification.missingDeclaredFiles.length}{" "}
										declared files missing.{" "}
										{selected.item.kind === "component" &&
											(selected.item.prepared
												? "Includes the upstream component demo wrapper."
												: "This component needs a composition wrapper.")}
									</p>
									<details>
										<summary className="cursor-pointer text-sm">
											Variables, dependencies and licenses
										</summary>
										<pre className="overflow-auto whitespace-pre-wrap text-xs">
											{JSON.stringify(
												{
													parameters: selected.item.parameters,
													variables: selected.item.variables,
													dependencies: selected.item.registryDependencies,
													licenses: selected.item.licensePaths,
												},
												null,
												2,
											)}
										</pre>
									</details>
									<div className="flex items-center justify-between">
										<h4 className="text-sm font-medium">Prompt</h4>
										<Button
											size="sm"
											variant="outline"
											disabled={!promptText}
											onClick={() =>
												void navigator.clipboard
													.writeText(promptText)
													.catch(() => setError("Could not copy the prompt"))
											}
										>
											Copy prompt
										</Button>
									</div>
									<p className="whitespace-pre-wrap text-sm">{promptText}</p>
									<p className="text-xs text-muted-foreground">
										Prompt provenance:{" "}
										{selected.item.prompt.status === "reconstructed"
											? "Reconstructed by OpenCut · שוחזר על ידי OpenCut"
											: selected.item.prompt.text
												? selected.item.prompt.status
												: "Suggested usage prompt · based on catalog metadata"}
									</p>
									<label className="block text-sm">
										Adapt this reference
										<textarea
											className="mt-1 block w-full rounded border bg-transparent p-2"
											maxLength={4000}
											value={remixBrief}
											onChange={(event) => setRemixBrief(event.target.value)}
											placeholder="Describe the changes for your video…"
										/>
									</label>
									<Button
										variant="outline"
										disabled={!remixBrief.trim()}
										onClick={() => {
											offerEditingAgentDraft({
												projectId,
												text: `Use HyperFrames reference ${selected.item.id} from pinned source ${selected.item.sourceUrl} (catalog generation ${selected.upstreamCommit}). Read its manifest with hyperframes.examples.read and the relevant files with hyperframes.examples.source.read; use its original or reviewed prompt when available. Captured entries are not certified: check dependencies and licensing, preview the result and verify the composed output before treating the edit as complete.\n\nMy requested remix: ${remixBrief.trim()}`,
											});
											onClose();
										}}
									>
										Prepare remix in chat
									</Button>
									<label className="block text-sm">
										Source file
										<select
											className="mt-1 block w-full rounded border bg-background p-2"
											value={page?.filePath ?? ""}
											disabled={busy}
											onChange={(event) => {
												if (event.target.value)
													void readSource({ filePath: event.target.value });
											}}
										>
											<option value="">Choose a text file</option>
											{selected.item.prepared && (
												<optgroup label="Prepared package">
													{selected.item.prepared.files.map((file) => (
														<option
															key={`@prepared/${file.path}`}
															value={`@prepared/${file.path}`}
														>
															{file.path} (prepared)
														</option>
													))}
												</optgroup>
											)}
											{selected.item.files
												.filter((file) =>
													/\.(html|css|js|mjs|json|svg|md|txt)$/.test(
														file.path,
													),
												)
												.map((file) => (
													<option key={file.path} value={file.path}>
														{file.path} ({file.bytes} bytes)
													</option>
												))}
										</select>
									</label>
									{selected.item.prepared && (
										<div className="space-y-2 rounded border p-3">
											<p className="text-xs text-muted-foreground">
												Prepared package: offline rendering, deterministic
												seeking, import and reopen passed.{" "}
												{selected.item.prompt.status === "reconstructed"
													? "A source and sampled-frame prompt review is available. "
													: "Prompt review remains pending. "}
												{selected.item.verification.status === "verified"
													? "Verified as a local reference package. Visual review covers three sampled frames; preview your own remix before export."
													: "Full library verification remains pending."}
											</p>
											<Button
												disabled={busy || importing}
												className="h-auto min-h-9 max-w-full whitespace-normal"
												onClick={() => void addPrepared()}
											>
												Add prepared example to timeline
											</Button>
										</div>
									)}
									{busy && (
										<p role="status" className="text-sm">
											Checking and reading source…
										</p>
									)}
									{page && (
										<>
											<pre
												className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs"
												dir="ltr"
											>
												{page.text}
											</pre>
											<div className="flex items-center gap-2">
												<span className="text-xs">
													Character {page.offset} of {page.totalCharacters}
												</span>
												<Button
													size="sm"
													variant="outline"
													disabled={busy || page.nextOffset === null}
													onClick={() => {
														if (page.nextOffset !== null)
															void readSource({
																filePath: page.filePath,
																sourceOffset: page.nextOffset,
															});
													}}
												>
													Read next part
												</Button>
											</div>
										</>
									)}
								</div>
							) : (
								<p className="text-sm text-muted-foreground">
									Select a reference to inspect its source and validation
									status.
								</p>
							)}
						</aside>
					)}
				</div>
			</div>
		</>
	);
	if (presentation !== "dialog")
		return (
			<section
				aria-label="HyperFrames examples library"
				className="flex h-full min-h-0 min-w-0 flex-col"
			>
				{content}
			</section>
		);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				aria-describedby={undefined}
				className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col"
			>
				<DialogTitle className="sr-only">
					Catalog · HyperFrames + OpenCut
				</DialogTitle>
				{content}
			</DialogContent>
		</Dialog>
	);
}
