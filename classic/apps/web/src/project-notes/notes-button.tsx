"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { FileText, Plus, Save, Trash2, X } from "lucide-react";
import { toast } from "@/i18n/toast";
import { useInterfaceLanguage } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { CanonicalButton } from "@/components/editor/canonical-button";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import {
	NOTE_BODY_LIMIT,
	PROJECT_NOTES_LIMIT,
	type ProjectNote,
} from "./types";

interface Draft {
	accountId: string;
	projectId: string;
	id: string;
	title: string;
	body: string;
	baseVersion?: number;
}

/** The only local data is an unsaved form draft. Persisted notes are runtime projections. */
export function NotesButton({ className }: { className?: string }) {
	const editor = useEditor();
	const { t } = useInterfaceLanguage();
	const accountId =
		typeof window !== "undefined"
			? (window.__opencutAccountId ?? "local")
			: "local";
	const formId = useId();
	const project = useEditorProject((e) => e.project.getActiveOrNull());
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState<Draft | null>(null);
	const notes = project?.notes ?? [];
	const visibleDraft =
		draft?.projectId === project?.metadata.id && draft?.accountId === accountId
			? draft
			: null;
	const currentNote = visibleDraft
		? notes.find((note) => note.id === visibleDraft.id)
		: undefined;
	const stale =
		visibleDraft?.baseVersion !== undefined &&
		currentNote?.version !== visibleDraft.baseVersion;

	function edit(note: ProjectNote) {
		if (!project) return;
		setDraft({
			projectId: project.metadata.id,
			accountId,
			id: note.id,
			title: note.title,
			body: note.body,
			baseVersion: note.version,
		});
	}

	function save(asNew = false) {
		if (
			!project ||
			!visibleDraft ||
			(stale && !asNew) ||
			visibleDraft.accountId !== (window.__opencutAccountId ?? "local")
		)
			return;
		try {
			const create = asNew || visibleDraft.baseVersion === undefined;
			const noteId = asNew ? crypto.randomUUID() : visibleDraft.id;
			editor.command.invokeCanonicalControl({
				projectId: visibleDraft.projectId,
				accountId: visibleDraft.accountId,
				capabilityId: "project.classic.notes.edit",
				input: {
					change: {
						type: create ? "create" : "update",
						noteId,
						title: visibleDraft.title.trim() || t("Untitled note"),
						body: visibleDraft.body,
						...(create
							? {}
							: { expectedNoteVersion: visibleDraft.baseVersion }),
					},
				},
			});
			setDraft(null);
			toast.success("Note saved");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "The note could not be saved. Your draft is still here.",
			);
		}
	}

	function saveShortcut(
		event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
	) {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			event.preventDefault();
			save();
		}
	}

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className={className}
					disabled={!project}
					aria-label={t("Project notes")}
				>
					<FileText className="size-4" />{" "}
					<span className="hidden lg:inline">{t("Notes")}</span>
				</Button>
			</SheetTrigger>
			<SheetContent
				className="flex w-full flex-col sm:max-w-lg"
				aria-label={t("Project notes")}
			>
				<SheetHeader className="pr-6">
					<SheetTitle>{t("Notes")}</SheetTitle>
					<SheetDescription>
						{t(
							"Keep outlines, decisions, and next steps with this project. Your editing agent can add notes here too.",
						)}
					</SheetDescription>
				</SheetHeader>
				<div className="min-h-0 flex-1 overflow-y-auto space-y-4 py-4">
					{visibleDraft ? (
						<form
							className="space-y-3 rounded-xl border p-4"
							onSubmit={(event) => {
								event.preventDefault();
								save();
							}}
						>
							<div className="flex items-center justify-between gap-2">
								<p className="text-sm font-medium">
									{visibleDraft.baseVersion === undefined
										? t("New note")
										: t("Edit note")}{" "}
									<span className="text-muted-foreground font-normal">
										· {t("Unsaved draft")}
									</span>
								</p>
								<Button
									variant="ghost"
									size="icon"
									aria-label={t("Discard note draft")}
									onClick={() => setDraft(null)}
								>
									<X />
								</Button>
							</div>
							<label
								htmlFor={`${formId}-title`}
								className="block space-y-1 text-sm"
							>
								<span>{t("Title")}</span>
								<Input
									id={`${formId}-title`}
									onKeyDown={saveShortcut}
									value={visibleDraft.title}
									maxLength={160}
									onChange={(event) =>
										setDraft({ ...visibleDraft, title: event.target.value })
									}
									placeholder={t("Untitled note")}
								/>
							</label>
							<label
								htmlFor={`${formId}-body`}
								className="block space-y-1 text-sm"
							>
								<span>{t("Note")}</span>
								<Textarea
									id={`${formId}-body`}
									onKeyDown={saveShortcut}
									className="min-h-52 resize-y leading-relaxed"
									value={visibleDraft.body}
									maxLength={NOTE_BODY_LIMIT}
									onChange={(event) =>
										setDraft({ ...visibleDraft, body: event.target.value })
									}
									placeholder={t("What should happen in this edit?")}
									dir="auto"
								/>
							</label>
							{stale && (
								<div
									role="alert"
									className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
								>
									<p>
										{t("This note changed elsewhere. Your draft is preserved.")}
									</p>
									<div className="mt-2 flex flex-wrap gap-2">
										{currentNote && (
											<Button
												variant="outline"
												size="sm"
												onClick={() => edit(currentNote)}
											>
												{t("Load latest note")}
											</Button>
										)}
										<Button
											variant="outline"
											size="sm"
											disabled={notes.length >= PROJECT_NOTES_LIMIT}
											onClick={() => save(true)}
										>
											{t("Save draft as new note")}
										</Button>
									</div>
								</div>
							)}
							<div className="flex items-center justify-between gap-2">
								<p className="text-xs text-muted-foreground">
									{t("Save with Ctrl / ⌘ + Enter")}
								</p>
								<Button type="submit" size="sm" disabled={stale}>
									<Save /> {t("Save note")}
								</Button>
							</div>
						</form>
					) : (
						<Button
							className="w-full"
							variant="outline"
							disabled={!project || notes.length >= PROJECT_NOTES_LIMIT}
							onClick={() =>
								project &&
								setDraft({
									projectId: project.metadata.id,
									accountId,
									id: crypto.randomUUID(),
									title: "",
									body: "",
								})
							}
						>
							<Plus /> {t("New note")}
						</Button>
					)}
					{notes.length === 0 && !visibleDraft && (
						<div className="rounded-xl border border-dashed px-6 py-10 text-center">
							<FileText className="mx-auto mb-3 size-7 text-muted-foreground" />
							<p className="text-sm font-medium">
								{t("A place for your next idea")}
							</p>
							<p className="mt-1 text-sm text-muted-foreground">
								{t("Add a brief, a shot list, or feedback to revisit.")}
							</p>
						</div>
					)}
					{notes.map((note) => (
						<article key={note.id} className="rounded-xl border p-4">
							<div className="flex items-start justify-between gap-2">
								<button
									type="button"
									className="min-w-0 flex-1 text-start"
									onClick={() => edit(note)}
									disabled={Boolean(visibleDraft)}
								>
									<h3 className="break-words font-medium" dir="auto">
										{note.title}
									</h3>
									<p
										className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground line-clamp-4"
										dir="auto"
									>
										{note.body || t("No details yet.")}
									</p>
								</button>
								<CanonicalButton
									variant="ghost"
									size="icon"
									aria-label={t("Remove note: {title}", { title: note.title })}
									title={t("Remove note (can be undone)")}
									disabled={Boolean(visibleDraft)}
									action={{
										capabilityId: "project.classic.notes.remove",
										input: {
											noteId: note.id,
											expectedNoteVersion: note.version,
										},
									}}
								>
									<Trash2 className="size-4" />
								</CanonicalButton>
							</div>
						</article>
					))}
					{notes.length >= PROJECT_NOTES_LIMIT && (
						<p className="text-sm text-muted-foreground">
							{t("This project has reached its {count}-note limit.", {
								count: PROJECT_NOTES_LIMIT,
							})}
						</p>
					)}
				</div>
				<p className="border-t pt-3 text-xs text-muted-foreground">
					{t("Saved with this project. Note changes support Undo and Redo.")}
				</p>
			</SheetContent>
		</Sheet>
	);
}
