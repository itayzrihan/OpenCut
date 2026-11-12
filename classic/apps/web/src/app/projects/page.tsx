"use client";
import { LocalizedValue as UiValue } from "@/i18n/message";
import { localizeClientMessage } from "@/i18n/client-messages";
import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import { ElectronBackButton } from "@/components/electron-back-button";
import {
	BatchEditButton,
	BatchProjectBadge,
	useBatchEdit,
} from "@/batch/provider";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ChangeEvent } from "react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/i18n/toast";
import type { EditorCore } from "@/core";
import { MigrationDialog } from "@/project/components/migration-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import { useProjectsStore } from "./store";
import type {
	TProjectMetadata,
	TProjectSortKey,
	TProjectSortOption,
} from "@/project/types";
import { formatTimecode, mediaTimeToSeconds } from "opencut-wasm";
import { formatDate } from "@/utils/date";
import { useInterfaceLanguage } from "@/i18n/provider";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowUpRight,
	FolderOpen,
	Layers3,
	Settings,
	Sparkles,
} from "lucide-react";
import { useWorkspaceAccount } from "@/accounts/gate";
import { ACCOUNT_WORKSPACE_HREF } from "@/accounts/workspace-route";
import { AccountSettingsPanel } from "@/accounts/settings-panel";
import { WorkspaceLink } from "@/components/workspace-link";
import { BRAND_KITS_HREF } from "@/brand-kits/types";
import { BrandKitsPanel } from "@/brand-kits/panel";
import { WorkspaceLoading } from "@/components/workspace-loading";
import { PocutWordmark } from "@/components/landing/pocut-brand";
import brand from "@/components/landing/pocut-brand.module.css";
import styles from "./projects.module.css";
import {
	Calendar04Icon,
	GridViewIcon,
	LeftToRightListDashIcon,
	PlusSignIcon,
	Search01Icon,
	Video01Icon,
	MoreHorizontalIcon,
	Delete02Icon,
	Copy01Icon,
	Edit03Icon,
	ArrowDown02Icon,
	InformationCircleIcon,
	FileImportIcon,
	Download04Icon,
} from "@hugeicons/core-free-icons";
import { Label } from "@/components/ui/label";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectsExportDialog } from "@/export/projects-export-dialog";
import { openRenderQueue } from "@/export/queue/client";
import { DeleteProjectDialog } from "@/project/components/delete-project-dialog";
import { ProjectInfoDialog } from "@/project/components/project-info-dialog";
import { RenameProjectDialog } from "@/project/components/rename-project-dialog";
import { cn } from "@/utils/ui";
import { filterAndSortProjectMetadata } from "@/core/managers/project-manager";
import { EXCHANGE_ACCEPT } from "@/project/archive/exchange-format";
import { ProjectImportDialog } from "@/project/archive/exchange-dialogs";
import type { StorageMigrationFailure } from "@/services/storage/migrations";
const formatProjectDuration = ({
	duration,
}: {
	duration: number | undefined;
}): string | null => {
	if (duration === undefined) {
		return null;
	}

	const durationSeconds = mediaTimeToSeconds({ time: duration });
	const format = durationSeconds >= 3600 ? "HH:MM:SS" : "MM:SS";
	return formatTimecode({ time: duration, format }) ?? "";
};

const VIEW_MODE_OPTIONS = [
	{ mode: "grid" as const, icon: GridViewIcon, label: "Grid view" },
	{ mode: "list" as const, icon: LeftToRightListDashIcon, label: "List view" },
];

export default function ProjectsPage() {
	return (
		<Suspense fallback={<WorkspaceLoading />}>
			<ProjectsWorkspace />
		</Suspense>
	);
}

function ProjectsWorkspace() {
	const requestedTab = useSearchParams().get("tab");
	const storageBusy = useWorkspaceAccount()?.storageBusy ?? false;
	const tab =
		storageBusy || requestedTab === "account"
			? "account"
			: requestedTab === "brand-kits"
				? "brand-kits"
				: "projects";
	const [openedBrandKits, setOpenedBrandKits] = useState(tab === "brand-kits");
	// Defer the library request until first use, then keep unsaved drafts across tab switches.
	if (tab === "brand-kits" && !openedBrandKits) setOpenedBrandKits(true);
	return (
		<div className={cn(brand.theme, brand.workspaceTheme, styles.workspace)}>
			<ProjectsNavigation tab={tab} />
			<main className={styles.main}>
				<ProjectsHeader storageBusy={storageBusy} />
				{openedBrandKits && (
					<div hidden={tab !== "brand-kits"}>
						<BrandKitsPanel />
					</div>
				)}
				{tab === "account" && <AccountSettingsPanel />}
				{tab === "projects" && <ProjectsLibrary />}
			</main>
		</div>
	);
}

function ProjectsLibrary() {
	const { searchQuery, sortKey, sortOrder, viewMode } = useProjectsStore();
	const editor = useEditor();
	const batch = useBatchEdit();
	const batchRevision = batch.state.runs
		.flatMap((r) =>
			r.jobs.map((j) => `${j.projectId}:${j.created}:${j.status}`),
		)
		.join(",");
	useEffect(() => {
		if (batch.loaded)
			void editor.project.refreshProjectMetadata().catch(console.error);
	}, [batch.loaded, batchRevision, editor]);
	const sortOption: TProjectSortOption = `${sortKey}-${sortOrder}`;

	const [
		isLoading,
		isInitialized,
		savedProjects,
		loadError,
		migrationFailures,
	] = useEditorProject((e) => [
		e.project.getIsLoading(),
		e.project.getIsInitialized(),
		e.project.getSavedProjects(),
		e.project.getLoadError(),
		e.project.getMigrationFailures(),
	]);

	const projectsToDisplay = useMemo(
		() =>
			filterAndSortProjectMetadata({
				projects: savedProjects,
				searchQuery,
				sortOption,
			}),
		[savedProjects, searchQuery, sortOption],
	);
	const projectIds = useMemo(
		() => projectsToDisplay.map((project) => project.id),
		[projectsToDisplay],
	);

	useEffect(() => {
		if (!editor.project.getIsInitialized()) {
			void editor.project.loadAllProjects();
		}
	}, [editor.project]);

	return (
		<>
			<MigrationDialog />
			<ProjectsToolbar
				projectIds={projectIds}
				isLoading={isLoading || !isInitialized}
			/>
			{isLoading || !isInitialized ? (
				<ProjectsSkeleton />
			) : (
				<>
					{migrationFailures.length > 0 ? (
						<ProjectsMigrationWarning failures={migrationFailures} />
					) : null}
					{loadError ? <ProjectsLoadError error={loadError} /> : null}
					{loadError &&
					savedProjects.length === 0 ? null : projectsToDisplay.length === 0 ? (
						<EmptyState />
					) : (
						<div className={viewMode === "grid" ? styles.grid : styles.list}>
							{projectsToDisplay.map((project, index) => (
								<ProjectItem
									key={project.id}
									project={project}
									allProjectIds={projectIds}
									prioritizeThumbnail={index < 4}
								/>
							))}
						</div>
					)}
				</>
			)}
		</>
	);
}

function ProjectsNavigation({
	tab,
}: {
	tab: "projects" | "brand-kits" | "account";
}) {
	const account = useWorkspaceAccount();
	const { t } = useInterfaceLanguage();

	return (
		<aside className={styles.rail}>
			<PocutWordmark />
			<div className={cn(brand.eyebrow, styles.railLabel)}>
				<UiMessage text={"Studio workspace"} />
			</div>
			<UiLocalized<"nav">
				element={"nav"}
				messageProps={["aria-label"]}
				aria-label="Workspace navigation"
				className={styles.railLinks}
			>
				<WorkspaceLink
					href="/projects"
					aria-current={tab === "projects" ? "page" : undefined}
					aria-disabled={account?.storageBusy}
				>
					<FolderOpen size={17} /> <UiMessage text={"Projects"} />
				</WorkspaceLink>
				<WorkspaceLink
					href={BRAND_KITS_HREF}
					aria-current={tab === "brand-kits" ? "page" : undefined}
					aria-disabled={account?.storageBusy}
				>
					<Layers3 size={17} /> <UiMessage text={"Brand Kits"} />
				</WorkspaceLink>
			</UiLocalized>
			<div className={styles.railFooter}>
				{account?.canConnectLegitate && (
					<form action="/api/accounts/legitate/start" method="post">
						<Button type="submit" variant="outline">
							<UiMessage text={"Connect Legitate"} />
						</Button>
					</form>
				)}
				<WorkspaceLink
					href={ACCOUNT_WORKSPACE_HREF}
					aria-label={t("Account and storage settings")}
					aria-current={tab === "account" ? "page" : undefined}
					className={styles.account}
				>
					<Settings size={17} />
					<span>
						<strong>
							{account?.displayName || <UiMessage text={"Account"} />}
						</strong>
						<small>
							<UiMessage text={"Account & storage"} />
						</small>
					</span>
				</WorkspaceLink>
			</div>
		</aside>
	);
}

function ProjectsHeader({ storageBusy }: { storageBusy: boolean }) {
	return (
		<header className={styles.hero}>
			<div>
				<div className="flex flex-wrap items-center gap-3">
					<ElectronBackButton />
					<span className={cn(brand.eyebrow, styles.kicker)}>
						<Sparkles size={14} /> <UiMessage text={"Welcome to POCUT"} />
					</span>
				</div>
				<h1>
					<UiMessage text={"Your projects"} />
				</h1>
				<p>
					<UiMessage text={"Start a new cut or pick up where you left off."} />
				</p>
				{!storageBusy && (
					<div className={styles.heroActions}>
						<NewProjectButton />
						<ImportProjectButton />
						<BatchEditButton />
						<Button variant="outline" onClick={openRenderQueue}>
							<UiMessage text="Render Queue" />
						</Button>
					</div>
				)}
			</div>
		</header>
	);
}

const SORT_LABELS: Record<TProjectSortKey, string> = {
	createdAt: "Created",
	updatedAt: "Modified",
	name: "Name",
	duration: "Duration",
};

function ProjectsToolbar({
	projectIds,
	isLoading,
}: {
	projectIds: string[];
	isLoading: boolean;
}) {
	const { t } = useInterfaceLanguage();
	const {
		selectedProjectIds,
		sortKey,
		sortOrder,
		setSortOrder,
		setSelectedProjects,
		clearSelectedProjects,
		viewMode,
		setViewMode,
		isHydrated,
	} = useProjectsStore();

	const selectedProjectCount = selectedProjectIds.length;
	const isAllSelected =
		projectIds.length > 0 && selectedProjectCount === projectIds.length;
	const hasSomeSelected =
		selectedProjectCount > 0 && selectedProjectCount < projectIds.length;

	const handleSelectAll = ({ checked }: { checked: boolean }) => {
		if (checked) {
			setSelectedProjects({ projectIds });
			return;
		}
		clearSelectedProjects();
	};

	return (
		<UiLocalized<"section">
			element={"section"}
			messageProps={["aria-label"]}
			className={styles.library}
			aria-label="Project library controls"
		>
			<div className={styles.libraryTop}>
				<div className={styles.libraryTitle}>
					<h2>
						<UiMessage text={"Project library"} />
					</h2>
					{!isLoading && <span>{projectIds.length}</span>}
				</div>
				<SearchBar />
			</div>
			<div className={styles.toolbar}>
				<div className={styles.tools}>
					<Label className={styles.selectAll} htmlFor="select-all-projects">
						<Checkbox
							id="select-all-projects"
							disabled={projectIds.length === 0}
							checked={
								isAllSelected ? true : hasSomeSelected ? "indeterminate" : false
							}
							onCheckedChange={(checked) =>
								handleSelectAll({ checked: checked === true })
							}
						/>
						<span>
							<UiMessage text={"Select all"} />
						</span>
					</Label>
					<div className={styles.sort}>
						<SortDropdown>
							<Button variant="ghost" className={styles.sortKey}>
								<UiMessage text={"Sort by"} /> {t(SORT_LABELS[sortKey])}
							</Button>
						</SortDropdown>
						<Button
							variant="ghost"
							size="icon"
							onClick={() =>
								setSortOrder({
									sortOrder: sortOrder === "asc" ? "desc" : "asc",
								})
							}
							aria-label={
								sortOrder === "asc" ? t("Sort descending") : t("Sort ascending")
							}
						>
							<HugeiconsIcon
								icon={ArrowDown02Icon}
								className={sortOrder === "asc" ? "rotate-180" : ""}
							/>
						</Button>
					</div>
				</div>
				<div className={styles.tools}>
					{selectedProjectCount > 0 && <ProjectActions />}
					<UiLocalized<"div">
						element={"div"}
						messageProps={["aria-label"]}
						className={styles.switcher}
						aria-label="Project layout"
						role="group"
					>
						{VIEW_MODE_OPTIONS.map(({ mode, icon, label }) => (
							<Button
								key={mode}
								variant="ghost"
								size="icon"
								onClick={() => setViewMode({ viewMode: mode })}
								aria-label={t(label)}
								aria-pressed={isHydrated && viewMode === mode}
							>
								<HugeiconsIcon icon={icon} />
							</Button>
						))}
					</UiLocalized>
				</div>
			</div>
		</UiLocalized>
	);
}

function SearchBar() {
	const { searchQuery, setSearchQuery } = useProjectsStore();
	return (
		<div className={styles.search}>
			<HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
			<UiLocalized<typeof Input>
				element={Input}
				messageProps={["aria-label", "placeholder"]}
				aria-label="Search projects"
				placeholder="Search projects"
				value={searchQuery}
				onChange={(event) => setSearchQuery({ query: event.target.value })}
				size="lg"
			/>
		</div>
	);
}

const PROJECT_ACTIONS = [
	{
		id: "duplicate",
		label: "Duplicate",
		icon: Copy01Icon,
		variant: "outline" as const,
	},
	{
		id: "export",
		label: "Export",
		icon: Download04Icon,
		variant: "outline" as const,
	},
	{
		id: "delete",
		label: "Delete",
		icon: Delete02Icon,
		variant: "destructive-foreground" as const,
	},
] as const;

async function deleteProjects({
	editor,
	ids,
}: {
	editor: EditorCore;
	ids: string[];
}) {
	await editor.project.deleteProjects({ ids });
}

async function duplicateProjects({
	editor,
	ids,
}: {
	editor: EditorCore;
	ids: string[];
}) {
	await editor.project.duplicateProjects({ ids });
}

async function renameProject({
	editor,
	id,
	name,
}: {
	editor: EditorCore;
	id: string;
	name: string;
}) {
	await editor.project.renameProject({ id, name });
}

function ProjectActions() {
	const { t } = useInterfaceLanguage();
	const editor = useEditor();
	const { selectedProjectIds, clearSelectedProjects } = useProjectsStore();
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
	const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);

	const savedProjects = editor.project.getSavedProjects();
	const selectedProjectNames = savedProjects
		.filter((project) => selectedProjectIds.includes(project.id))
		.map((project) => project.name);

	const handleDuplicate = async () => {
		await duplicateProjects({ editor, ids: selectedProjectIds });
		clearSelectedProjects();
	};

	const handleDeleteClick = () => {
		setIsDeleteDialogOpen(true);
	};

	const handleDeleteConfirm = async () => {
		try {
			await deleteProjects({ editor, ids: selectedProjectIds });
			clearSelectedProjects();
			setIsDeleteDialogOpen(false);
		} catch (error) {
			toast.error("Failed to delete projects", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
		}
	};

	const actionHandlers: Record<string, () => void> = {
		duplicate: handleDuplicate,
		export: () => setIsExportDialogOpen(true),
		delete: handleDeleteClick,
	};

	return (
		<>
			<div className="flex items-center gap-2.5 px-3">
				<div className="hidden sm:flex items-center gap-2.5">
					{PROJECT_ACTIONS.map((action) => (
						<Button
							key={action.id}
							aria-label={t(action.label)}
							title={t(action.label)}
							size="icon"
							variant={action.variant}
							className="size-9"
							onClick={actionHandlers[action.id]}
						>
							<HugeiconsIcon icon={action.icon} />
						</Button>
					))}
				</div>

				<DropdownMenu>
					<DropdownMenuTrigger asChild className="sm:hidden">
						<UiLocalized<typeof Button>
							element={Button}
							messageProps={["aria-label"]}
							size="icon"
							variant="outline"
							className="size-9"
							aria-label="Selected project actions"
						>
							<HugeiconsIcon icon={MoreHorizontalIcon} />
						</UiLocalized>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{PROJECT_ACTIONS.map((action) => (
							<DropdownMenuItem
								key={action.id}
								variant={action.id === "delete" ? "destructive" : undefined}
								onClick={actionHandlers[action.id]}
							>
								<HugeiconsIcon icon={action.icon} />
								{t(action.label)}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{isExportDialogOpen && (
				<ProjectsExportDialog
					projectIds={[...selectedProjectIds]}
					onClose={() => setIsExportDialogOpen(false)}
				/>
			)}
			<DeleteProjectDialog
				isOpen={isDeleteDialogOpen}
				onOpenChange={setIsDeleteDialogOpen}
				projectNames={selectedProjectNames}
				onConfirm={handleDeleteConfirm}
			/>
		</>
	);
}

function SortDropdown({ children }: { children: React.ReactNode }) {
	const { sortKey, setSortKey } = useProjectsStore();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
			<DropdownMenuContent className="w-48" align="center">
				<DropdownMenuRadioGroup value={sortKey}>
					{(["createdAt", "updatedAt", "name", "duration"] as const).map(
						(option) => (
							<DropdownMenuRadioItem
								key={option}
								value={option}
								onSelect={() => setSortKey({ sortKey: option })}
							>
								<UiMessage text={SORT_LABELS[option]} />
							</DropdownMenuRadioItem>
						),
					)}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function NewProjectButton() {
	const editor = useEditor();
	const router = useRouter();

	const handleCreateProject = async () => {
		try {
			const projectId = await editor.project.createNewProject({
				name: "New project",
			});
			router.push(`/editor/${projectId}`);
		} catch (error) {
			toast.error("Failed to create project", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
		}
	};

	return (
		<Button size="lg" className={brand.primary} onClick={handleCreateProject}>
			<HugeiconsIcon icon={PlusSignIcon} /> <UiMessage text={"New project"} />
		</Button>
	);
}

function ImportProjectButton({ className }: { className?: string }) {
	const editor = useEditor();
	const router = useRouter();
	const archiveInputRef = useRef<HTMLInputElement>(null);
	const [archiveFile, setArchiveFile] = useState<File | null>(null);
	const isImporting = archiveFile !== null;

	const handleImportProjectArchive = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = "";
		if (file && !isImporting) setArchiveFile(file);
	};

	return (
		<>
			{archiveFile && (
				<ProjectImportDialog
					file={archiveFile}
					onClose={() => setArchiveFile(null)}
					onImported={({ projectId }) => {
						router.push(`/editor/${projectId}`);
					}}
				/>
			)}
			<input
				ref={archiveInputRef}
				type="file"
				accept={EXCHANGE_ACCEPT}
				className="hidden"
				onChange={handleImportProjectArchive}
			/>
			<Button
				variant="outline"
				size="lg"
				className={cn("gap-2", className)}
				disabled={isImporting}
				onClick={() => archiveInputRef.current?.click()}
			>
				<HugeiconsIcon icon={FileImportIcon} />
				<span className="hidden sm:inline">
					{isImporting ? (
						<UiMessage text={"Importing..."} />
					) : (
						<UiMessage text={"Import ZIP or XML"} />
					)}
				</span>
				<span className="sm:hidden">
					{isImporting ? (
						<UiMessage text={"Importing..."} />
					) : (
						<UiMessage text={"Import"} />
					)}
				</span>
			</Button>
		</>
	);
}

function ProjectItem({
	project,
	allProjectIds,
	prioritizeThumbnail,
}: {
	project: TProjectMetadata;
	allProjectIds: string[];
	prioritizeThumbnail: boolean;
}) {
	const { locale } = useInterfaceLanguage();
	const {
		selectedProjectIds,
		viewMode,
		setProjectSelected,
		selectProjectRange,
	} = useProjectsStore();
	const selectedProjectIdSet = new Set(selectedProjectIds);
	const isSelected = selectedProjectIdSet.has(project.id);
	const selectedProjectCount = selectedProjectIds.length;
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);
	const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
	const [isInfoDialogOpen, setIsInfoDialogOpen] = useState(false);
	const editor = useEditor();
	const durationLabel = formatProjectDuration({ duration: project.duration });
	const isMultiSelect = selectedProjectCount > 1;
	const isGridView = viewMode === "grid";

	const handleRename = () => setIsRenameDialogOpen(true);
	const handleDuplicate = async () => {
		await duplicateProjects({ editor, ids: [project.id] });
	};
	const handleDeleteClick = () => setIsDeleteDialogOpen(true);
	const handleInfoClick = () => setIsInfoDialogOpen(true);
	const handleDeleteConfirm = async () => {
		try {
			await deleteProjects({ editor, ids: [project.id] });
			setIsDeleteDialogOpen(false);
		} catch (error) {
			toast.error("Failed to delete project", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
		}
	};

	const handleCheckboxChange = ({
		checked,
		shiftKey,
	}: {
		checked: boolean;
		shiftKey: boolean;
	}) => {
		if (shiftKey && checked) {
			selectProjectRange({ projectId: project.id, allProjectIds });
			return;
		}
		setProjectSelected({ projectId: project.id, isSelected: checked });
	};

	const gridContent = (
		<Card className={cn(styles.projectCard, isSelected && styles.selected)}>
			<div className={styles.thumbnail}>
				<div className="absolute inset-0">
					{project.thumbnail ? (
						<Image
							src={project.thumbnail}
							unoptimized={project.thumbnail.startsWith("/api/local-drive/")}
							alt=""
							fill
							loading={prioritizeThumbnail ? "eager" : "lazy"}
							sizes="(max-width: 639px) 100vw, (max-width: 1023px) 33vw, 25vw"
							className="object-cover"
						/>
					) : (
						<div className="flex size-full items-center justify-center">
							<HugeiconsIcon
								icon={Video01Icon}
								className={styles.placeholder}
							/>
						</div>
					)}
				</div>

				{durationLabel && (
					<div className={styles.duration}>{durationLabel}</div>
				)}
			</div>

			<CardContent className={styles.cardBody}>
				<BatchProjectBadge projectId={project.id} />
				<h3 className={styles.cardName}>
					{project.name}
					<ArrowUpRight size={15} aria-hidden="true" />
				</h3>
				<div className={styles.cardDate}>
					<HugeiconsIcon icon={Calendar04Icon} className="size-4" />
					<span>
						<UiMessage text={"Created"} />{" "}
						{formatDate({ date: project.createdAt, locale })}
					</span>
				</div>
			</CardContent>
		</Card>
	);

	const listRowContent = (
		<div className="flex items-center gap-3 flex-1 min-w-0">
			<div className={styles.rowThumbnail}>
				{project.thumbnail ? (
					<Image
						src={project.thumbnail}
						unoptimized={project.thumbnail.startsWith("/api/local-drive/")}
						alt=""
						fill
						loading={prioritizeThumbnail ? "eager" : "lazy"}
						sizes="40px"
						className="object-cover"
					/>
				) : (
					<div className="flex size-full items-center justify-center">
						<HugeiconsIcon
							icon={Video01Icon}
							className="text-muted-foreground size-5 shrink-0"
						/>
					</div>
				)}
			</div>

			<h3 className="group-hover:text-foreground/90 text-sm font-medium truncate flex-1 min-w-0">
				{project.name}
			</h3>

			<span className="text-muted-foreground text-sm shrink-0 hidden sm:block">
				{durationLabel ?? "—"}
			</span>

			<span className="text-muted-foreground text-sm shrink-0 w-auto pl-8 text-right hidden xs:block">
				{formatDate({ date: project.createdAt, locale })}
			</span>
		</div>
	);

	const listContent = (
		<div className={cn(styles.row, isSelected && styles.selected)}>
			<Checkbox
				checked={isSelected}
				onMouseDown={(event) => event.preventDefault()}
				onClick={(event) => {
					handleCheckboxChange({
						checked: !isSelected,
						shiftKey: event.shiftKey,
					});
				}}
				onCheckedChange={() => {}}
				aria-label={`Select ${project.name}`}
				className="size-5 shrink-0"
			/>

			<Link href={`/editor/${project.id}`} className="flex-1 min-w-0">
				{listRowContent}
			</Link>

			{!isMultiSelect && (
				<ProjectMenu
					isOpen={isDropdownOpen}
					onOpenChange={setIsDropdownOpen}
					variant="list"
					onRenameClick={handleRename}
					onDuplicateClick={handleDuplicate}
					onDeleteClick={handleDeleteClick}
					onInfoClick={handleInfoClick}
				/>
			)}
		</div>
	);

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div className="group relative">
						{isGridView ? (
							<>
								<Link href={`/editor/${project.id}`} className="block">
									{gridContent}
								</Link>

								<Checkbox
									checked={isSelected}
									onMouseDown={(event) => event.preventDefault()}
									onClick={(event) => {
										handleCheckboxChange({
											checked: !isSelected,
											shiftKey: event.shiftKey,
										});
									}}
									onCheckedChange={() => {}}
									aria-label={`Select ${project.name}`}
									className={styles.cardCheck}
								/>

								{!isMultiSelect && (
									<ProjectMenu
										isOpen={isDropdownOpen}
										onOpenChange={setIsDropdownOpen}
										onRenameClick={handleRename}
										onDuplicateClick={handleDuplicate}
										onDeleteClick={handleDeleteClick}
										onInfoClick={handleInfoClick}
									/>
								)}
							</>
						) : (
							listContent
						)}
					</div>
				</ContextMenuTrigger>
				<ProjectContextMenuContent
					onRenameClick={handleRename}
					onDuplicateClick={handleDuplicate}
					onDeleteClick={handleDeleteClick}
					onInfoClick={handleInfoClick}
				/>
			</ContextMenu>

			<RenameProjectDialog
				isOpen={isRenameDialogOpen}
				onOpenChange={setIsRenameDialogOpen}
				projectName={project.name}
				onConfirm={async (newName) => {
					await renameProject({ editor, id: project.id, name: newName });
					setIsRenameDialogOpen(false);
				}}
			/>

			<DeleteProjectDialog
				isOpen={isDeleteDialogOpen}
				onOpenChange={setIsDeleteDialogOpen}
				projectNames={[project.name]}
				onConfirm={handleDeleteConfirm}
			/>

			<ProjectInfoDialog
				isOpen={isInfoDialogOpen}
				onOpenChange={setIsInfoDialogOpen}
				project={project}
			/>
		</>
	);
}

function ProjectContextMenuContent({
	onRenameClick,
	onDuplicateClick,
	onDeleteClick,
	onInfoClick,
}: {
	onRenameClick: () => void;
	onDuplicateClick: () => void;
	onDeleteClick: () => void;
	onInfoClick: () => void;
}) {
	return (
		<ContextMenuContent>
			<ContextMenuItem
				icon={<HugeiconsIcon icon={Edit03Icon} />}
				onClick={onRenameClick}
			>
				<UiMessage text={"Rename"} />
			</ContextMenuItem>
			<ContextMenuItem
				icon={<HugeiconsIcon icon={Copy01Icon} />}
				onClick={onDuplicateClick}
			>
				<UiMessage text={"Duplicate"} />
			</ContextMenuItem>
			<ContextMenuItem
				icon={<HugeiconsIcon icon={InformationCircleIcon} />}
				onClick={onInfoClick}
			>
				<UiMessage text={"Info"} />
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem
				variant="destructive"
				icon={<HugeiconsIcon icon={Delete02Icon} />}
				onClick={onDeleteClick}
			>
				<UiMessage text={"Delete"} />
			</ContextMenuItem>
		</ContextMenuContent>
	);
}

function ProjectMenu({
	isOpen,
	onOpenChange,
	variant = "grid",
	onRenameClick,
	onDuplicateClick,
	onDeleteClick,
	onInfoClick,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	variant?: "grid" | "list";
	onRenameClick: () => void;
	onDuplicateClick: () => void;
	onDeleteClick: () => void;
	onInfoClick: () => void;
}) {
	const handleRename = () => {
		onRenameClick();
		onOpenChange(false);
	};

	const handleDuplicate = () => {
		onDuplicateClick();
		onOpenChange(false);
	};

	const handleDeleteClick = () => {
		onDeleteClick();
		onOpenChange(false);
	};

	const handleInfoClick = () => {
		onInfoClick();
		onOpenChange(false);
	};

	const isGrid = variant === "grid";

	return (
		<DropdownMenu open={isOpen} onOpenChange={onOpenChange}>
			<DropdownMenuTrigger asChild>
				<UiLocalized<typeof Button>
					element={Button}
					messageProps={["aria-label"]}
					variant="background"
					className={isGrid ? styles.cardMenu : styles.rowMenu}
					size="icon"
					aria-label="Project menu"
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
					}}
					onMouseDown={(event) => event.stopPropagation()}
				>
					<HugeiconsIcon
						icon={MoreHorizontalIcon}
						className="text-foreground"
						aria-hidden="true"
					/>
				</UiLocalized>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-48" align="end">
				<DropdownMenuItem onClick={handleRename}>
					<HugeiconsIcon icon={Edit03Icon} />
					<UiMessage text={"Rename"} />
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleDuplicate}>
					<HugeiconsIcon icon={Copy01Icon} />
					<UiMessage text={"Duplicate"} />
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleInfoClick}>
					<HugeiconsIcon icon={InformationCircleIcon} />
					<UiMessage text={"Info"} />
				</DropdownMenuItem>
				<DropdownMenuItem variant="destructive" onClick={handleDeleteClick}>
					<HugeiconsIcon icon={Delete02Icon} />
					<UiMessage text={"Delete"} />
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ProjectsSkeleton() {
	const skeletonIds = Array.from(
		{ length: 6 },
		(_, index) => `skeleton-${index}`,
	);

	return (
		<UiLocalized<"div">
			element={"div"}
			messageProps={["aria-label"]}
			className={styles.grid}
			aria-label="Loading projects"
			aria-busy="true"
		>
			{skeletonIds.map((skeletonId) => (
				<Card key={skeletonId} className={styles.projectCard}>
					<div className="bg-muted relative aspect-video">
						<div className="absolute inset-0">
							<Skeleton className="bg-muted/50 size-full" />
						</div>
					</div>
					<CardContent className={styles.cardBody}>
						<Skeleton className="bg-muted/50 h-4 w-3/4" />
						<div className="text-muted-foreground flex items-center gap-1.5">
							<Skeleton className="bg-muted/50 size-4" />
							<Skeleton className="bg-muted/50 h-4 w-24" />
						</div>
					</CardContent>
				</Card>
			))}
		</UiLocalized>
	);
}

function ProjectsLoadError({ error }: { error: string }) {
	const editor = useEditor();

	return (
		<div
			role="alert"
			className="mx-4 flex flex-col gap-4 rounded-lg border border-destructive/35 bg-destructive/5 p-5 sm:flex-row sm:items-center sm:justify-between"
		>
			<div className="flex min-w-0 gap-3">
				<div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
					<HugeiconsIcon
						icon={InformationCircleIcon}
						className="size-5 text-destructive"
					/>
				</div>
				<div className="min-w-0">
					<h3 className="font-medium">
						<UiMessage text={"Projects could not be read"} />
					</h3>
					<p className="mt-1 text-sm text-muted-foreground">
						<UiMessage
							text={
								"Your stored project data has not been deleted. Retry the browser storage read, or import a project ZIP backup."
							}
						/>
					</p>
					<p className="mt-2 break-words font-mono text-xs text-muted-foreground">
						<UiValue>{error}</UiValue>
					</p>
				</div>
			</div>
			<div className="flex shrink-0 flex-wrap gap-2">
				<Button
					variant="outline"
					size="lg"
					onClick={() => void editor.project.loadAllProjects()}
				>
					<UiMessage text={"Retry"} />
				</Button>
				<ImportProjectButton />
			</div>
		</div>
	);
}

function ProjectsMigrationWarning({
	failures,
}: {
	failures: StorageMigrationFailure[];
}) {
	const editor = useEditor();
	const projectNames = failures.map(
		(failure) => failure.projectName ?? failure.projectId,
	);

	return (
		<div
			role="alert"
			className="mx-4 flex flex-col gap-4 rounded-lg border border-amber-500/35 bg-amber-500/5 p-5 sm:flex-row sm:items-center sm:justify-between"
		>
			<div className="flex min-w-0 gap-3">
				<div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
					<HugeiconsIcon
						icon={InformationCircleIcon}
						className="size-5 text-amber-700 dark:text-amber-300"
					/>
				</div>
				<div className="min-w-0">
					<h3 className="font-medium">
						{failures.length === 1 ? (
							<UiMessage text={"One project needs recovery"} />
						) : (
							<UiMessage
								text={"{v0} projects need recovery"}
								values={{ v0: String(failures.length) }}
							/>
						)}
					</h3>
					<p className="mt-1 text-sm text-muted-foreground">
						<UiMessage
							text={
								"POCUT stopped before another unsafe write. Recoverable data was preserved: either the live record stayed untouched or a pre-upgrade safety snapshot was saved. Other readable projects remain available."
							}
						/>
					</p>
					<p className="mt-2 break-words text-xs text-muted-foreground">
						{projectNames.join(", ")}
					</p>
				</div>
			</div>
			<div className="flex shrink-0 flex-wrap gap-2">
				<Button
					variant="outline"
					size="lg"
					onClick={() => void editor.project.loadAllProjects()}
				>
					<UiMessage text={"Retry upgrade"} />
				</Button>
				<ImportProjectButton />
			</div>
		</div>
	);
}

function EmptyState() {
	const { searchQuery, setSearchQuery } = useProjectsStore();
	const router = useRouter();
	const editor = useEditor();
	const savedProjects = editor.project.getSavedProjects();

	const handleCreateProject = async () => {
		try {
			const projectId = await editor.project.createNewProject({
				name: "New project",
			});
			router.push(`/editor/${projectId}`);
		} catch (error) {
			toast.error("Failed to create project", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
		}
	};

	if (savedProjects.length > 0) {
		return (
			<div className={styles.empty}>
				<div className="flex flex-col items-center gap-8">
					<HugeiconsIcon
						icon={Search01Icon}
						className="text-muted-foreground size-16 bg-accent/35 border rounded-md p-4"
					/>
					<div className="flex flex-col items-center gap-3">
						<h3 className="text-lg font-medium">
							<UiMessage text={"No results found"} />
						</h3>
						<p className="text-muted-foreground max-w-md">
							<UiMessage text={"Your search for “"} />
							{searchQuery}
							<UiMessage text={"” did not return any results."} />
						</p>
					</div>
				</div>
				<Button
					onClick={() => setSearchQuery({ query: "" })}
					variant="outline"
					size="lg"
				>
					<UiMessage text={"Clear search"} />
				</Button>
			</div>
		);
	}

	return (
		<div className={styles.empty}>
			<div className="flex flex-col items-center gap-2">
				<div className="bg-muted/30 flex size-16 items-center justify-center rounded-full">
					<HugeiconsIcon
						icon={Video01Icon}
						className="text-muted-foreground size-8"
					/>
				</div>
				<h3 className="text-lg font-medium">
					<UiMessage text={"No projects yet"} />
				</h3>
				<p className="text-muted-foreground max-w-md">
					<UiMessage
						text={
							"This account has no projects yet. Create a project, import a project ZIP, or bring your existing work from Account & storage."
						}
					/>
				</p>
			</div>
			<div className="flex flex-wrap justify-center gap-3">
				<Button size="lg" className="gap-2" onClick={handleCreateProject}>
					<HugeiconsIcon icon={PlusSignIcon} />
					<UiMessage text={"Create your first project"} />
				</Button>
				<ImportProjectButton />
			</div>
		</div>
	);
}
