"use client";
import { useEffect, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { Message, LocalizedValue } from "@/i18n/message";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	downloadProjectExchange,
	importProjectExchange,
	readProjectExchange,
	type ExchangeImportPlan,
} from "./exchange";
import { assetKey, suggestExchangeFiles } from "./exchange-format";
import { toast } from "@/i18n/toast";
import { localizeClientMessage } from "@/i18n/client-messages";

export function ProjectExportDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const [format, setFormat] = useState<"zip" | "xml">("zip");
	const [busy, setBusy] = useState(false),
		[error, setError] = useState(""),
		[progress, setProgress] = useState("");
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	async function run() {
		const project = editor.project.getActiveOrNull();
		if (!project || busy) return;
		const scope = {
			projectId: project.metadata.id,
			accountId: window.__opencutAccountId,
		};
		const abort = new AbortController();
		controller.current = abort;
		setBusy(true);
		setError("");
		setProgress("");
		try {
			const blob = await editor.project.exportProjectArchive({
				format,
				signal: abort.signal,
				onProgress: setProgress,
				onUnavailableArtifacts: (count) => {
					if (count)
						toast.info(
							localizeClientMessage(
								"{v0} earlier Agent files are no longer available. Their conversation entries are preserved.",
								{ v0: String(count) },
							),
						);
				},
			});
			abort.signal.throwIfAborted();
			if (
				editor.project.getActiveOrNull()?.metadata.id !== scope.projectId ||
				window.__opencutAccountId !== scope.accountId
			)
				throw new Error("The active project changed during export");
			downloadProjectExchange(blob, project.metadata.name, format);
			onOpenChange(false);
		} catch (error) {
			if (!abort.signal.aborted)
				setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
			controller.current = null;
		}
	}
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!value) controller.current?.abort();
				onOpenChange(value);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						<Message text="Export project" />
					</DialogTitle>
					<DialogDescription>
						<Message text="Choose a complete media package or a smaller POCUT metadata file." />
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<label className="flex cursor-pointer gap-3 rounded-lg border p-4">
						<input
							type="radio"
							name="project-export-format"
							checked={format === "zip"}
							disabled={busy}
							onChange={() => setFormat("zip")}
						/>
						<span>
							<strong className="block">
								<Message text="Full project ZIP" />
							</strong>
							<span className="text-sm text-muted-foreground">
								<Message text="Includes original media, generated references, fonts, editing history and production scripts." />
							</span>
						</span>
					</label>
					<label className="flex cursor-pointer gap-3 rounded-lg border p-4">
						<input
							type="radio"
							name="project-export-format"
							checked={format === "xml"}
							disabled={busy}
							onChange={() => setFormat("xml")}
						/>
						<span>
							<strong className="block">
								<Message text="POCUT project XML — metadata only" />
							</strong>
							<span className="text-sm text-muted-foreground">
								<Message text="Preserves the edit and history without media bytes. Select the original files when importing. This is POCUT XML, not a Premiere or Final Cut interchange file." />
							</span>
						</span>
					</label>
					{busy && (
						<p role="status" className="break-all text-sm">
							<Message text="Preparing project export…" /> {progress}
						</p>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							<LocalizedValue>{error}</LocalizedValue>
						</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => {
							controller.current?.abort();
							onOpenChange(false);
						}}
					>
						<Message text="Cancel" />
					</Button>
					<Button disabled={busy} onClick={() => void run()}>
						<Message text="Download project" />
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function ProjectImportDialog({
	file,
	onClose,
	onImported,
}: {
	file: File;
	onClose: () => void;
	onImported: (result: {
		projectId: string;
		projectName: string;
	}) => Promise<void> | void;
}) {
	const editor = useEditor();
	const [plan, setPlan] = useState<ExchangeImportPlan | null>(null),
		[legacy, setLegacy] = useState(false);
	const [loading, setLoading] = useState(true),
		[busy, setBusy] = useState(false),
		[error, setError] = useState(""),
		[progress, setProgress] = useState("");
	const [files, setFiles] = useState(new Map<string, File>());
	const [completed, setCompleted] = useState<{
		projectId: string;
		projectName: string;
	} | null>(null);
	const controller = useRef(new AbortController());
	const input = useRef<HTMLInputElement>(null);
	const account = useRef(window.__opencutAccountId);
	useEffect(() => {
		const abort = new AbortController();
		controller.current = abort;
		setLoading(true);
		setPlan(null);
		setLegacy(false);
		setError("");
		setFiles(new Map());
		void readProjectExchange(file, abort.signal)
			.then((plan) => {
				if (abort.signal.aborted) return;
				setPlan(plan);
				setLegacy(!plan);
				if (plan) setFiles(plan.files);
			})
			.catch((error) => {
				if (!abort.signal.aborted)
					setError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (!abort.signal.aborted) setLoading(false);
			});
		return () => abort.abort();
	}, [file]);
	const missing =
		plan?.payload.assets.filter((asset) => !files.has(assetKey(asset))) ?? [];
	async function confirm() {
		if (busy || loading) return;
		setBusy(true);
		setError("");
		try {
			if (window.__opencutAccountId !== account.current)
				throw new Error("The account changed during project import");
			const result =
				completed ??
				(legacy
					? await editor.project.importProjectArchive({ file })
					: await importProjectExchange({
							plan: plan!,
							selections: files,
							signal: controller.current.signal,
							onProgress: setProgress,
						}));
			setCompleted(result);
			controller.current.signal.throwIfAborted();
			if (window.__opencutAccountId !== account.current)
				throw new Error("The account changed during project import");
			await onImported(result);
			onClose();
		} catch (error) {
			if (!controller.current.signal.aborted)
				setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) {
					controller.current.abort();
					onClose();
				}
			}}
		>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						<Message text="Import POCUT project" />
					</DialogTitle>
					<DialogDescription>
						<Message text="A separate project will be created. Existing projects and files are kept." />
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="max-h-[60vh] overflow-auto">
					{loading && (
						<p role="status">
							<Message text="Validating project and editing history…" />
						</p>
					)}
					{legacy && (
						<p>
							<Message text="This ZIP uses the earlier POCUT archive format." />
						</p>
					)}
					{plan && (
						<>
							<h3 className="font-semibold">{plan.payload.projectName}</h3>
							{!!plan.payload.unavailableArtifactIds?.length && (
								<p className="text-sm text-muted-foreground">
									<Message
										text="{v0} earlier Agent files are no longer available. Their conversation entries are preserved."
										values={{
											v0: String(plan.payload.unavailableArtifactIds.length),
										}}
									/>
								</p>
							)}
							<p className="text-sm text-muted-foreground">
								<Message
									text={
										missing.length
											? "Choose the original files listed below. Matching names and sizes are suggested; ambiguous files need an explicit choice. Recorded checksums are verified before import."
											: "All required files are selected. Their recorded checksums will be verified before import."
									}
								/>
							</p>
							<input
								ref={input}
								type="file"
								multiple
								className="hidden"
								onChange={(event) => {
									const selected = Array.from(event.currentTarget.files ?? []);
									event.currentTarget.value = "";
									setFiles(
										(previous) =>
											new Map([
												...previous,
												...suggestExchangeFiles(plan.payload.assets, selected),
											]),
									);
								}}
							/>
							<Button
								variant="outline"
								disabled={busy || !!completed}
								onClick={() => input.current?.click()}
							>
								<Message text="Select original files" />
							</Button>
							<p role="status" className="text-sm">
								<Message
									text="{v0} files still need to be linked"
									values={{ v0: String(missing.length) }}
								/>
							</p>
							<div className="space-y-2">
								{plan.payload.assets.map((asset) => (
									<div
										key={assetKey(asset)}
										className="rounded border p-3 text-sm"
									>
										<div className="flex items-center justify-between gap-3">
											<span
												id={`archive-file-${assetKey(asset)}`}
												className="min-w-0 break-all font-medium"
											>
												{asset.fileName}
											</span>
											<label className="shrink-0 cursor-pointer text-primary underline">
												<span id={`archive-choose-${assetKey(asset)}`}>
													<Message text="Choose file" />
												</span>
												<input
													type="file"
													aria-labelledby={`archive-choose-${assetKey(asset)} archive-file-${assetKey(asset)}`}
													disabled={busy || !!completed}
													className="sr-only"
													onChange={(event) => {
														const selected = event.currentTarget.files?.[0];
														if (selected)
															setFiles((previous) =>
																new Map(previous).set(
																	assetKey(asset),
																	selected,
																),
															);
														event.currentTarget.value = "";
													}}
												/>
											</label>
										</div>
										<p className="text-xs text-muted-foreground">
											<Message
												text={
													{
														media: "Media",
														director: "Generated reference",
														font: "Font",
														sharedAudio: "Shared audio",
														sharedSticker: "Sticker",
														artifact: "Agent artifact",
													}[asset.kind]
												}
											/>{" "}
											· {asset.size.toLocaleString()} <Message text="bytes" />
										</p>
										<p
											className={
												files.has(assetKey(asset))
													? "text-emerald-600"
													: "text-amber-600"
											}
										>
											{files.has(assetKey(asset)) ? (
												<>
													<Message text="Selected:" />{" "}
													{files.get(assetKey(asset))!.name}
												</>
											) : (
												<Message text="Original file missing" />
											)}
										</p>
									</div>
								))}
							</div>
						</>
					)}
					{busy && (
						<p role="status" className="break-all text-sm">
							<Message text="Verifying and importing files…" /> {progress}
						</p>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							<LocalizedValue>{error}</LocalizedValue>
						</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => {
							controller.current.abort();
							onClose();
						}}
					>
						<Message text="Cancel" />
					</Button>
					<Button
						disabled={
							busy ||
							loading ||
							(!legacy && !plan) ||
							(!completed && missing.length > 0)
						}
						onClick={() => void confirm()}
					>
						<Message
							text={
								completed ? "Open imported project" : "Import as new project"
							}
						/>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
