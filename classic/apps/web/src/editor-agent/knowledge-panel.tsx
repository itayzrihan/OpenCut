"use client";
import { useCallback, useEffect, useRef, useState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
	knowledgeRequest,
	knowledgeDocumentSchema,
	knowledgeSummarySchema,
	type KnowledgeDocument,
	type KnowledgeSummary,
} from "./knowledge-client";
import styles from "./overlay.module.css";

export function KnowledgePanel({ projectId }: { projectId: string }) {
	const contentId = useId();
	const [entries, setEntries] = useState<KnowledgeSummary[]>([]),
		[revision, setRevision] = useState(0);
	const [selected, setSelected] = useState<KnowledgeDocument | null>(null),
		[query, setQuery] = useState("");
	const [editing, setEditing] = useState(false),
		[kind, setKind] = useState<"skill" | "memory">("memory"),
		[global, setGlobal] = useState(false);
	const [title, setTitle] = useState(""),
		[body, setBody] = useState(""),
		[tags, setTags] = useState("");
	const [error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	const [draftId, setDraftId] = useState("");
	const pendingMutation = useRef<{
		fingerprint: string;
		expectedRevision: number;
		idempotencyKey: string;
		change: unknown;
	} | null>(null);
	const requestController = useRef<AbortController | null>(null),
		mounted = useRef(true);
	const refresh = useCallback(
		async (search: string) => {
			requestController.current?.abort();
			const controller = new AbortController();
			requestController.current = controller;
			const response = await knowledgeRequest({
				projectId,
				request: {
					type: "search",
					query: search,
					location: null,
					includeDisabled: true,
				},
				signal: controller.signal,
			});
			if (!mounted.current || controller.signal.aborted) return;
			setRevision(response.revision);
			setEntries(knowledgeSummarySchema.array().parse(response.data));
		},
		[projectId],
	);
	useEffect(() => {
		mounted.current = true;
		void refresh("").catch((cause) => {
			if (mounted.current && !requestController.current?.signal.aborted)
				setError(String(cause));
		});
		return () => {
			mounted.current = false;
			requestController.current?.abort();
		};
	}, [refresh]);
	const open = async (item: KnowledgeSummary) => {
		setBusy(true);
		setError("");
		try {
			const response = await knowledgeRequest({
				projectId,
				request: { type: "read", key: item.key, location: item.location },
			});
			if (!mounted.current) return;
			const document = knowledgeDocumentSchema.parse(response.data),
				head = document.versions.at(-1)!;
			setRevision(response.revision);
			setSelected(document);
			setTitle(head.content.title);
			setBody(head.content.body);
			setTags(head.content.tags.join(", "));
			setKind(document.key.kind);
			setGlobal(document.location.type === "global");
			setEditing(true);
		} catch (cause) {
			if (mounted.current) setError(String(cause));
		} finally {
			if (mounted.current) setBusy(false);
		}
	};
	const mutate = async (change: unknown) => {
		setBusy(true);
		setError("");
		const fingerprint = JSON.stringify(change);
		const mutation =
			pendingMutation.current?.fingerprint === fingerprint
				? pendingMutation.current
				: {
						fingerprint,
						expectedRevision: revision,
						idempotencyKey: crypto.randomUUID(),
						change,
					};
		pendingMutation.current = mutation;
		try {
			await knowledgeRequest({
				projectId,
				request: {
					type: "mutate",
					mutation: {
						expectedRevision: mutation.expectedRevision,
						idempotencyKey: mutation.idempotencyKey,
						change: mutation.change,
					},
				},
			});
			if (!mounted.current) return;
			pendingMutation.current = null;
			setEditing(false);
			setSelected(null);
			await refresh(query);
		} catch (cause) {
			if (mounted.current) setError(String(cause));
		} finally {
			if (mounted.current) setBusy(false);
		}
	};
	const head = selected?.versions.at(-1);
	const readOnly =
		selected?.location.type === "builtin" ||
		(selected?.location.type === "project" &&
			selected.location.projectId !== projectId);
	const save = () =>
		void mutate(
			selected
				? {
						type: "update",
						key: selected.key,
						location: selected.location,
						expectedVersion: head!.version,
						content: {
							title,
							body,
							tags: tags
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean),
							enabled: head!.content.enabled,
						},
					}
				: {
						type: "create",
						key: { kind, id: draftId },
						location: global
							? { type: "global" }
							: { type: "project", projectId },
						content: {
							title,
							body,
							tags: tags
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean),
							enabled: true,
						},
					},
		);
	return (
		<section className={styles.knowledge} aria-label="Skills and memory">
			<div className={styles.knowledgeToolbar}>
				<strong>Skills & memory</strong>
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					onClick={() => {
						setEditing(false);
						void refresh(query).catch((cause) => setError(String(cause)));
					}}
				>
					Refresh
				</Button>
			</div>
			<p className={styles.knowledgeHint}>
				Private to your account. Project versions override matching global
				knowledge.
			</p>
			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			{editing ? (
				<>
					<div className={styles.knowledgeToolbar}>
						<Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
							← Library
						</Button>
						<span>
							{selected?.location.type ?? (global ? "global" : "project")} ·{" "}
							{kind}
						</span>
					</div>
					{!selected && (
						<div className={styles.knowledgeToolbar}>
							<select
								aria-label="Knowledge type"
								value={kind}
								onChange={(e) =>
									setKind(e.target.value === "skill" ? "skill" : "memory")
								}
							>
								<option value="memory">Memory</option>
								<option value="skill">Skill</option>
							</select>
							<select
								aria-label="Knowledge scope"
								value={global ? "global" : "project"}
								onChange={(e) => setGlobal(e.target.value === "global")}
							>
								<option value="project">This project</option>
								<option value="global">All my projects</option>
							</select>
						</div>
					)}
					<label>
						Title
						<input
							dir="auto"
							value={title}
							disabled={readOnly || busy}
							maxLength={300}
							onChange={(e) => setTitle(e.target.value)}
						/>
					</label>
					<label htmlFor={contentId}>
						Content
						<Textarea
							id={contentId}
							dir="auto"
							value={body}
							disabled={readOnly || busy}
							className={styles.knowledgeBody}
							maxLength={100000}
							onChange={(e) => setBody(e.target.value)}
						/>
					</label>
					<label>
						Tags, separated by commas
						<input
							dir="auto"
							value={tags}
							disabled={readOnly || busy}
							onChange={(e) => setTags(e.target.value)}
						/>
					</label>
					{head?.deleted && (
						<p>
							This item is archived. Restore an earlier version to use it again.
						</p>
					)}
					<div className={styles.knowledgeToolbar}>
						{!readOnly && (
							<Button
								size="sm"
								disabled={
									busy || !title.trim() || !body.trim() || head?.deleted
								}
								onClick={save}
							>
								Save
							</Button>
						)}
						{selected && (
							<Button
								variant="outline"
								size="sm"
								disabled={busy || head?.deleted}
								onClick={() =>
									void mutate({
										type: "copy",
										key: selected.key,
										from: selected.location,
										to: { type: "project", projectId },
										newId:
											selected.location.type === "project"
												? crypto.randomUUID()
												: selected.key.id,
									})
								}
							>
								{readOnly ? "Copy into this project" : "Duplicate"}
							</Button>
						)}
						{selected && !readOnly && (
							<Button
								variant="ghost"
								size="sm"
								disabled={busy || head?.deleted}
								onClick={() =>
									void mutate({
										type: "delete",
										key: selected.key,
										location: selected.location,
										expectedVersion: head!.version,
									})
								}
							>
								Archive
							</Button>
						)}
					</div>
					{selected && (
						<details>
							<summary>Version history · {selected.versions.length}</summary>
							{[...selected.versions].reverse().map((version) => (
								<div key={version.version} className={styles.knowledgeToolbar}>
									<span>
										v{version.version} ·{" "}
										{new Date(version.savedAtMs).toLocaleString()}
										{version.deleted ? " · archived" : ""}
									</span>
									{!readOnly && version.version !== head!.version && (
										<Button
											variant="text"
											size="sm"
											disabled={busy}
											onClick={() =>
												void mutate({
													type: "revert",
													key: selected.key,
													location: selected.location,
													expectedVersion: head!.version,
													version: version.version,
												})
											}
										>
											Restore
										</Button>
									)}
								</div>
							))}
						</details>
					)}
				</>
			) : (
				<>
					<form
						className={styles.knowledgeToolbar}
						onSubmit={(e) => {
							e.preventDefault();
							void refresh(query).catch((cause) => setError(String(cause)));
						}}
					>
						<input
							aria-label="Search skills and memory"
							placeholder="Search your library…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
						/>
						<Button type="submit" variant="outline" size="sm">
							Search
						</Button>
					</form>
					<Button
						size="sm"
						disabled={busy}
						onClick={() => {
							setSelected(null);
							setDraftId(crypto.randomUUID());
							setTitle("");
							setBody("");
							setTags("");
							setGlobal(false);
							setEditing(true);
						}}
					>
						Add skill or memory
					</Button>
					{entries.map((item) => (
						<article
							key={JSON.stringify([item.key, item.location])}
							className={styles.knowledgeItem}
						>
							<button
								type="button"
								disabled={busy}
								onClick={() => void open(item)}
							>
								<strong dir="auto">{item.title}</strong>
								<span>
									{item.key.kind} · {item.location.type}
									{item.location.type === "project" &&
									item.location.projectId !== projectId
										? " · other project"
										: ""}{" "}
									· v{item.version}
									{item.deleted
										? " · archived"
										: !item.enabled
											? " · disabled"
											: ""}
								</span>
								<p dir="auto">{item.description}</p>
							</button>
							<div className={styles.knowledgeToolbar}>
								{!item.readOnly && !item.deleted && (
									<Button
										size="sm"
										variant="text"
										disabled={busy}
										onClick={() =>
											void mutate({
												type: "enable",
												key: item.key,
												location: item.location,
												expectedVersion: item.version,
												enabled: !item.enabled,
											})
										}
									>
										{item.enabled ? "Disable" : "Enable"}
									</Button>
								)}
								{item.location.type !== "project" && (
									<Button
										size="sm"
										variant="text"
										disabled={busy}
										onClick={() =>
											void mutate({
												type: "useGlobal",
												key: item.key,
												enabled: item.excludedInProject,
											})
										}
									>
										{item.excludedInProject
											? "Use in this project"
											: "Exclude from this project"}
									</Button>
								)}
							</div>
						</article>
					))}
				</>
			)}
		</section>
	);
}
