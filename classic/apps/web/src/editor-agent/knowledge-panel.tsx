"use client";
import { SettingsInfo } from "./settings-info";
import { LocalizedValue as UiValue } from "@/i18n/message";
import {
	LocalizedElement as UiLocalized,
	Message as UiMessage,
} from "@/i18n/message";
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
			}).catch((cause: unknown) => {
				if (
					controller.signal.aborted ||
					requestController.current !== controller
				)
					return undefined;
				throw cause;
			});
			if (!response || !mounted.current || controller.signal.aborted) return;
			setError("");
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
		<UiLocalized<"section">
			element={"section"}
			messageProps={["aria-label"]}
			className={styles.knowledge}
			aria-label="Skills and memory"
		>
			<div className={styles.knowledgeToolbar}>
				<SettingsInfo>
					<UiMessage
						text={
							"Private to your account. Project versions override matching global knowledge."
						}
					/>
				</SettingsInfo>
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					onClick={() => {
						setEditing(false);
						void refresh(query).catch((cause) => setError(String(cause)));
					}}
				>
					<UiMessage text={"Refresh"} />
				</Button>
			</div>

			{error && (
				<p role="alert" className={styles.error}>
					<UiValue>{error}</UiValue>
				</p>
			)}
			{editing ? (
				<>
					<div className={styles.knowledgeToolbar}>
						<Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
							<UiMessage text={"← Library"} />
						</Button>
						<span>
							{selected?.location.type ??
								(global ? (
									<UiMessage text={"global"} />
								) : (
									<UiMessage text={"project"} />
								))}{" "}
							· {kind}
						</span>
					</div>
					{!selected && (
						<div className={styles.knowledgeToolbar}>
							<UiLocalized<"select">
								element={"select"}
								messageProps={["aria-label"]}
								aria-label="Knowledge type"
								value={kind}
								onChange={(e) =>
									setKind(e.target.value === "skill" ? "skill" : "memory")
								}
							>
								<UiLocalized<"option">
									element={"option"}
									messageProps={["children"]}
									value="memory"
								>
									{"Memory"}
								</UiLocalized>
								<UiLocalized<"option">
									element={"option"}
									messageProps={["children"]}
									value="skill"
								>
									{"Skill"}
								</UiLocalized>
							</UiLocalized>
							<UiLocalized<"select">
								element={"select"}
								messageProps={["aria-label"]}
								aria-label="Knowledge scope"
								value={global ? "global" : "project"}
								onChange={(e) => setGlobal(e.target.value === "global")}
							>
								<UiLocalized<"option">
									element={"option"}
									messageProps={["children"]}
									value="project"
								>
									{"This project"}
								</UiLocalized>
								<UiLocalized<"option">
									element={"option"}
									messageProps={["children"]}
									value="global"
								>
									{"All my projects"}
								</UiLocalized>
							</UiLocalized>
						</div>
					)}
					<label>
						<UiMessage text={"Title"} />
						<input
							dir="auto"
							value={title}
							disabled={readOnly || busy}
							maxLength={300}
							onChange={(e) => setTitle(e.target.value)}
						/>
					</label>
					<label htmlFor={contentId}>
						<UiMessage text={"Content"} />
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
						<UiMessage text={"Tags, separated by commas"} />
						<input
							dir="auto"
							value={tags}
							disabled={readOnly || busy}
							onChange={(e) => setTags(e.target.value)}
						/>
					</label>
					{head?.deleted && (
						<p>
							<UiMessage
								text={
									"This item is archived. Restore an earlier version to use it again."
								}
							/>
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
								<UiMessage text={"Save"} />
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
								{readOnly ? (
									<UiMessage text={"Copy into this project"} />
								) : (
									<UiMessage text={"Duplicate"} />
								)}
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
								<UiMessage text={"Archive"} />
							</Button>
						)}
					</div>
					{selected && (
						<details>
							<summary>
								<UiMessage text={"Version history ·"} />{" "}
								{selected.versions.length}
							</summary>
							{[...selected.versions].reverse().map((version) => (
								<div key={version.version} className={styles.knowledgeToolbar}>
									<span>
										v{version.version} ·{" "}
										{new Date(version.savedAtMs).toLocaleString()}
										{version.deleted ? (
											<>
												{" "}
												<UiMessage text={"· archived"} />
											</>
										) : (
											""
										)}
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
											<UiMessage text={"Restore"} />
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
						<UiLocalized<"input">
							element={"input"}
							messageProps={["aria-label", "placeholder"]}
							aria-label="Search skills and memory"
							placeholder="Search your library…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
						/>
						<Button type="submit" variant="outline" size="sm">
							<UiMessage text={"Search"} />
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
						<UiMessage text={"Add skill or memory"} />
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
									item.location.projectId !== projectId ? (
										<>
											{" "}
											<UiMessage text={"· other project"} />
										</>
									) : (
										""
									)}{" "}
									· v{item.version}
									{item.deleted ? (
										<>
											{" "}
											<UiMessage text={"· archived"} />
										</>
									) : !item.enabled ? (
										<>
											{" "}
											<UiMessage text={"· disabled"} />
										</>
									) : (
										""
									)}
								</span>
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
										{item.enabled ? (
											<UiMessage text={"Disable"} />
										) : (
											<UiMessage text={"Enable"} />
										)}
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
										{item.excludedInProject ? (
											<UiMessage text={"Use in this project"} />
										) : (
											<UiMessage text={"Exclude from this project"} />
										)}
									</Button>
								)}
							</div>
						</article>
					))}
				</>
			)}
		</UiLocalized>
	);
}
