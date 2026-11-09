"use client";
import { LocalizedValue as UiValue } from "@/i18n/message";
import {
	LocalizedElement as UiLocalized,
	Message as UiMessage,
} from "@/i18n/message";
import { useEffect, useState } from "react";
import { Plus, Palette, Trash2, Copy, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { brandKitRequest } from "@/brand-kits/client";
import {
	BRAND_IMAGE_MIME_TYPES,
	MAX_BRAND_IMAGES,
	newBrandKit,
	type BrandKit,
	type BrandKitLibrary,
} from "@/brand-kits/types";
import { sharedLibraryService } from "@/shared-library/service";
import type {
	SharedAudioAsset,
	SharedStickerAsset,
} from "@/shared-library/types";
import { storageService } from "@/services/storage/service";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";
import {
	buildUniqueFontFamily,
	CUSTOM_FONT_ACCEPT,
	getSupportedFontMimeType,
	loadProjectFont,
} from "@/fonts/custom-fonts";
import type { ProjectFontAsset } from "@/fonts/types";
import { accountAssetUrl } from "@/accounts/browser";
import { useInterfaceLanguage } from "@/i18n/provider";
import brand from "@/components/landing/pocut-brand.module.css";
import { BrandImages } from "./brand-images";

export function BrandKitsPanel() {
	const { t } = useInterfaceLanguage();
	const [library, setLibrary] = useState<BrandKitLibrary | null>(null),
		[draft, setDraft] = useState<BrandKit | null>(null);
	const [dirty, setDirty] = useState(false),
		[busy, setBusy] = useState(false),
		[error, setError] = useState(""),
		[notice, setNotice] = useState("");
	const [sounds, setSounds] = useState<SharedAudioAsset[]>([]),
		[logos, setLogos] = useState<SharedStickerAsset[]>([]),
		[fonts, setFonts] = useState<ProjectFontAsset[]>([]),
		[logoUrl, setLogoUrl] = useState<string | null>(null);
	async function loadAssets() {
		const [audio, stickers, sharedFonts] = await Promise.all([
			sharedLibraryService.listAudioAssets(),
			sharedLibraryService.listStickerAssets(),
			storageService.loadAllSharedFonts(),
		]);
		setSounds(audio);
		setLogos(stickers);
		setFonts(sharedFonts);
		await Promise.all(sharedFonts.map((font) => loadProjectFont({ font })));
	}
	useEffect(() => {
		let active = true;
		void brandKitRequest()
			.then((data) => {
				if (active) setLibrary(data);
			})
			.catch((e) => {
				if (active) setError(e.message);
			});
		void loadAssets().catch((e) => {
			if (active) setError(e.message);
		});
		return () => {
			active = false;
		};
	}, []);
	useEffect(() => {
		let active = true;
		setLogoUrl(null);
		if (draft?.logo)
			void sharedLibraryService
				.getStickerAssetUrl({ id: draft.logo.assetId })
				.then((url) => {
					if (active) setLogoUrl(url);
				})
				.catch(() => {});
		return () => {
			active = false;
		};
	}, [draft?.logo?.assetId]);
	useEffect(() => {
		if (!dirty) return;
		const guard = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", guard);
		return () => window.removeEventListener("beforeunload", guard);
	}, [dirty]);
	const fontNames = [
		...new Set([...SYSTEM_FONTS, ...fonts.map((font) => font.family)]),
	];
	function update(patch: Partial<BrandKit>) {
		setDraft((value) => (value ? { ...value, ...patch } : value));
		setDirty(true);
		setNotice("");
	}
	function select(kit: BrandKit) {
		if (dirty && !window.confirm("Discard unsaved changes to this Brand Kit?"))
			return;
		setDraft(structuredClone(kit));
		setDirty(false);
		setError("");
		setNotice("");
	}
	async function persist(
		change:
			| { type: "upsert"; kit: BrandKit }
			| { type: "remove"; kitId: string },
	) {
		if (!library || busy) return;
		setBusy(true);
		setError("");
		try {
			const data = await brandKitRequest({
				edit: {
					expectedRevision: library.revision,
					requestId: crypto.randomUUID(),
					change,
				},
			});
			setLibrary(data);
			if (change.type === "upsert") {
				const saved = data.kits.find((kit) => kit.id === change.kit.id);
				if (saved) setDraft(saved);
			}
			setDirty(false);
			setNotice("Brand Kit saved");
			return data;
		} catch (e) {
			setError(
				`${e instanceof Error ? e.message : String(e)}. Your draft is preserved. Reload the library before retrying if another tab edited it.`,
			);
		} finally {
			setBusy(false);
		}
	}
	async function upload({
		kind,
		file,
	}: {
		kind: "logo" | "music" | "sfx" | "font";
		file: File;
	}) {
		if (!draft || busy) return;
		const id = draft.id,
			account = window.__opencutAccountId;
		setBusy(true);
		setError("");
		try {
			if (
				file.size >
				(kind === "logo" || kind === "font" ? 20 : 100) * 1024 * 1024
			)
				throw new Error("File is too large");
			let patch: Partial<BrandKit>;
			if (kind === "logo") {
				if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
					throw new Error("Choose a PNG, JPEG, WebP or GIF logo");
				const [asset] = await sharedLibraryService.importStickerFiles({
					files: [file],
				});
				if (!asset?.width || !asset.height)
					throw new Error("The logo could not be decoded");
				patch = {
					logo: { assetId: asset.id, width: asset.width, height: asset.height },
				};
			} else if (kind === "font") {
				const mimeType = getSupportedFontMimeType({ file });
				if (!mimeType) throw new Error("Choose a TTF, OTF, WOFF or WOFF2 font");
				const family = buildUniqueFontFamily({
					fileName: file.name,
					existingFamilies: fontNames,
				});
				const font: ProjectFontAsset = {
					id: crypto.randomUUID(),
					family,
					fileName: file.name,
					mimeType,
					size: file.size,
					lastModified: file.lastModified,
					createdAt: new Date().toISOString(),
					file,
				};
				await loadProjectFont({ font });
				await storageService.saveSharedFont({ font });
				patch = { headingFont: family, bodyFont: family };
			} else {
				if (!file.type.startsWith("audio/"))
					throw new Error("Choose an audio file");
				const [asset] = await sharedLibraryService.importAudioFiles({
					files: [file],
					folder: kind,
				});
				if (!asset) throw new Error("Audio import failed");
				patch =
					kind === "music"
						? { musicIds: [...draft.musicIds, asset.id] }
						: { sfxIds: [...draft.sfxIds, asset.id] };
			}
			if (window.__opencutAccountId !== account)
				throw new Error("Account changed during upload");
			setDraft((value) => (value?.id === id ? { ...value, ...patch } : value));
			setDirty(true);
			await loadAssets();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}
	async function uploadImages(files: File[]) {
		if (!draft || busy || !files.length) return;
		const kitId = draft.id;
		const account = window.__opencutAccountId;
		setBusy(true);
		setError("");
		try {
			if ((draft.images?.length ?? 0) + files.length > MAX_BRAND_IMAGES)
				throw new Error(t("A Brand Kit can contain up to 64 images"));
			if (
				files.some(
					(file) => !BRAND_IMAGE_MIME_TYPES.includes(file.type) || !file.size,
				) ||
				files.reduce((size, file) => size + file.size, 0) > 20 * 1024 * 1024
			)
				throw new Error(
					t("Choose PNG, JPEG, WebP or GIF images, up to 20 MB per upload."),
				);
			if (!account || window.__opencutAccountId !== account)
				throw new Error("Account changed during upload");
			const imported = await sharedLibraryService.importStickerFiles({
				files,
				requireDecodableImage: true,
			});
			if (window.__opencutAccountId !== account)
				throw new Error("Account changed during upload");
			if (imported.length !== files.length)
				throw new Error(t("Some images could not be imported"));
			setLogos((assets) => [...imported, ...assets]);
			setDraft((value) =>
				value?.id === kitId
					? {
							...value,
							images: [
								...(value.images ?? []),
								...imported.map((asset) => ({
									assetId: asset.id,
									name:
										[...asset.name.replace(/\p{Cc}/gu, " ").trim()]
											.slice(0, 64)
											.join("") || t("Image"),
									kind: "image" as const,
									tags: [],
								})),
							],
						}
					: value,
			);
			setDirty(true);
			setNotice("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}
	const field = ({ label, key }: { label: string; key: "name" | "style" }) => (
		<label className="grid gap-2 text-sm font-medium">
			{t(label)}
			{key === "style" ? (
				<textarea
					className="min-h-28 rounded-lg border bg-background p-3 font-normal"
					maxLength={2000}
					value={draft?.style ?? ""}
					onChange={(e) => update({ style: e.target.value })}
					placeholder={t(
						"Describe the brand’s tone, audience and visual style. For example: confident, minimal, warm; avoid flashy transitions.",
					)}
				/>
			) : (
				<UiLocalized<typeof Input>
					element={Input}
					messageProps={["placeholder"]}
					required
					maxLength={100}
					value={draft?.name ?? ""}
					onChange={(e) => update({ name: e.target.value })}
					placeholder="Client or brand name"
				/>
			)}
		</label>
	);
	const uploadButton = ({
		kind,
		label,
	}: {
		kind: "logo" | "music" | "sfx" | "font";
		label: string;
	}) => (
		<label
			className={`inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs ${busy ? "pointer-events-none opacity-50" : ""}`}
		>
			<Upload size={14} />
			{t(label)}
			<input
				type="file"
				className="sr-only"
				disabled={busy}
				accept={
					kind === "logo"
						? "image/png,image/jpeg,image/webp,image/gif"
						: kind === "font"
							? CUSTOM_FONT_ACCEPT
							: "audio/*"
				}
				onChange={(e) => {
					const file = e.target.files?.[0];
					e.target.value = "";
					if (file) void upload({ kind: kind, file: file });
				}}
			/>
		</label>
	);
	return (
		<section aria-label={t("Brand Kits")} className="min-w-0 space-y-5 py-2">
			<header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card/75 p-5">
				<div>
					<h2 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">
						<Palette className="size-5 text-primary" aria-hidden="true" />
						<UiMessage text={"Brand Kits"} />
					</h2>
					<p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
						<UiMessage
							text={
								"Save a kit for each client, then choose it when you run Full Auto Edit. Create as many as you need."
							}
						/>
					</p>
				</div>
				<div className="flex gap-3">
					<Button
						className={brand.primary}
						disabled={!library || busy}
						onClick={() => select(newBrandKit())}
					>
						<Plus />
						<UiMessage text={"New Brand Kit"} />
					</Button>
				</div>
			</header>
			{error && (
				<div
					role="alert"
					className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive"
				>
					<UiValue>{error}</UiValue>
					<Button
						className="ms-3"
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() =>
							void brandKitRequest()
								.then(setLibrary)
								.then(() =>
									setError("Library reloaded; your draft is preserved."),
								)
								.catch((e) => setError(e.message))
						}
					>
						<UiMessage text={"Reload library"} />
					</Button>
				</div>
			)}
			{notice && (
				<p role="status" className="text-sm">
					<UiValue>{notice}</UiValue>
				</p>
			)}
			{!library ? (
				<p role="status">
					<UiMessage text={"Loading Brand Kits…"} />
				</p>
			) : (
				<div className="grid min-w-0 items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
					<aside className="space-y-3">
						<p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
							<UiMessage text={"Brand Kits ·"} /> {library.kits.length}
						</p>
						{library.kits.map((kit) => (
							<button
								key={kit.id}
								disabled={busy}
								onClick={() => select(kit)}
								aria-pressed={draft?.id === kit.id}
								className={`w-full rounded-xl border bg-card/75 p-4 text-start transition-colors hover:bg-muted ${draft?.id === kit.id ? "border-primary/60 bg-primary/10" : ""}`}
							>
								<span className="block truncate font-medium">{kit.name}</span>
								<span className="mt-3 flex gap-1.5">
									{[
										kit.primaryColor,
										kit.secondaryColor,
										kit.backgroundColor,
									].map((color, index) => (
										<span
											key={index}
											className="size-5 rounded-full border"
											style={{ background: color }}
										/>
									))}
								</span>
								<span className="mt-2 block text-xs text-muted-foreground">
									{kit.headingFont} · {kit.musicIds.length + kit.sfxIds.length}{" "}
									<UiMessage text={"sounds"} />
								</span>
							</button>
						))}
						{!library.kits.length && (
							<div className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
								<UiMessage
									text={
										"Your clients’ brands will live here. Create your first kit to get started."
									}
								/>
							</div>
						)}
					</aside>
					{draft ? (
						<form
							className="grid min-w-0 items-start gap-5 2xl:grid-cols-[minmax(0,1fr)_230px]"
							onSubmit={(e) => {
								e.preventDefault();
								if (!busy)
									void persist({
										type: "upsert",
										kit: {
											...draft,
											images: draft.images?.map((image) => ({
												...image,
												name: image.name.trim(),
											})),
											phrases: draft.phrases
												.map((phrase) => phrase.trim())
												.filter(Boolean),
										},
									});
							}}
						>
							<fieldset disabled={busy} className="min-w-0 space-y-6">
								<section className="space-y-4 rounded-xl border bg-card/75 p-5">
									{field({ label: "Brand name", key: "name" })}
									<div className="grid gap-3 sm:grid-cols-3">
										{(
											[
												["primaryColor", "Primary"],
												["secondaryColor", "Secondary"],
												["backgroundColor", "Background"],
											] as const
										).map(([key, label]) => (
											<label
												key={key}
												className="grid gap-2 text-xs font-medium"
											>
												{label}
												<div className="flex items-center gap-2 rounded-lg border p-2">
													<input
														type="color"
														aria-label={`${label} color`}
														className="size-8 cursor-pointer rounded"
														value={draft[key]}
														onChange={(e) => update({ [key]: e.target.value })}
													/>
													<input
														aria-label={`${label} hex`}
														className="w-20 bg-transparent font-mono text-xs"
														pattern="#[0-9a-fA-F]{6}"
														maxLength={7}
														value={draft[key]}
														onChange={(e) => update({ [key]: e.target.value })}
													/>
												</div>
											</label>
										))}
									</div>
									{field({ label: "Brand style", key: "style" })}
									<label className="grid gap-2 text-sm font-medium">
										<UiMessage text={"Brand phrases"} />
										<textarea
											className="min-h-24 rounded-lg border bg-background p-3 font-normal"
											value={draft.phrases.join("\n")}
											maxLength={8000}
											onChange={(e) =>
												update({ phrases: e.target.value.split("\n") })
											}
											placeholder="One phrase per line. The first phrase appears as an editable closing line."
										/>
									</label>
								</section>
								<BrandImages
									key={draft.id}
									images={draft.images ?? []}
									assets={logos}
									onUpload={(files) => void uploadImages(files)}
									onChange={(images) => update({ images })}
								/>
								<section className="space-y-4 rounded-xl border bg-card/75 p-5">
									<h2 className="font-medium">
										<UiMessage text={"Logo & typography"} />
									</h2>
									<div className="flex flex-wrap items-center gap-3">
										{uploadButton({ kind: "logo", label: "Upload logo" })}
										<UiLocalized<"select">
											element={"select"}
											messageProps={["aria-label"]}
											aria-label="Logo from library"
											className="h-9 max-w-56 rounded-md border bg-background px-2 text-sm"
											value={draft.logo?.assetId ?? ""}
											onChange={(e) => {
												const asset = logos.find(
													(a) => a.id === e.target.value,
												);
												update({
													logo:
														asset?.width && asset.height
															? {
																	assetId: asset.id,
																	width: asset.width,
																	height: asset.height,
																}
															: null,
												});
											}}
										>
											<UiLocalized<"option">
												element={"option"}
												messageProps={["children"]}
												value=""
											>
												{"No logo"}
											</UiLocalized>
											{logos.map((asset) => (
												<option key={asset.id} value={asset.id}>
													{asset.name}
												</option>
											))}
										</UiLocalized>
									</div>
									<div className="grid gap-4 sm:grid-cols-2">
										{(
											[
												["headingFont", "Headings"],
												["bodyFont", "Captions & body"],
											] as const
										).map(([key, label]) => (
											<label key={key} className="grid gap-2 text-sm">
												{label}
												<select
													className="h-10 rounded-md border bg-background px-3"
													aria-label={label}
													value={draft[key]}
													onChange={(e) => update({ [key]: e.target.value })}
												>
													{[...new Set([...fontNames, draft[key]])].map(
														(font) => (
															<option key={font}>{font}</option>
														),
													)}
												</select>
											</label>
										))}
									</div>
									{uploadButton({ kind: "font", label: "Upload a brand font" })}
								</section>
								<section className="space-y-5 rounded-xl border bg-card/75 p-5">
									<h2 className="font-medium">
										<UiMessage text={"Brand sounds"} />
									</h2>
									<p className="text-xs text-muted-foreground">
										<UiMessage
											text={
												"Choose music for Automatic Music and effects for transition/word finishing. Empty selections keep the default sound library."
											}
										/>
									</p>
									{(["music", "sfx"] as const).map((kind) => (
										<div key={kind} className="space-y-2">
											<div className="flex items-center justify-between">
												<h3 className="text-sm font-medium">
													{kind === "music" ? (
														<UiMessage text={"Music"} />
													) : (
														<UiMessage text={"Sound effects"} />
													)}
												</h3>
												{uploadButton({
													kind: kind,
													label:
														kind === "music" ? "Upload music" : "Upload SFX",
												})}
											</div>
											<div className="max-h-44 space-y-2 overflow-y-auto rounded-lg border p-3">
												{sounds
													.filter((a) => a.folder === kind)
													.map((asset) => {
														const key =
															kind === "music" ? "musicIds" : "sfxIds";
														return (
															<label
																key={asset.id}
																className="flex items-center gap-2 text-sm"
															>
																<input
																	type="checkbox"
																	checked={draft[key].includes(asset.id)}
																	onChange={(e) =>
																		update({
																			[key]: e.target.checked
																				? [...draft[key], asset.id]
																				: draft[key].filter(
																						(id) => id !== asset.id,
																					),
																		})
																	}
																/>
																<span className="truncate">{asset.name}</span>
															</label>
														);
													})}
												{!sounds.some((a) => a.folder === kind) && (
													<p className="text-xs text-muted-foreground">
														<UiMessage
															text={"No sounds yet. Upload one to begin."}
														/>
													</p>
												)}
											</div>
										</div>
									))}
								</section>
								<div className="flex flex-wrap gap-3">
									<Button type="submit" className={brand.primary}>
										{busy ? <Loader2 className="animate-spin" /> : null}
										<UiMessage text={"Save Brand Kit"} />
										{dirty ? " *" : ""}
									</Button>
									<Button
										type="button"
										variant="outline"
										disabled={busy}
										onClick={() =>
											select({
												...structuredClone(draft),
												id: crypto.randomUUID(),
												name: `${draft.name} copy`,
											})
										}
									>
										<Copy />
										<UiMessage text={"Duplicate"} />
									</Button>
									{library.kits.some((kit) => kit.id === draft.id) && (
										<Button
											type="button"
											variant="ghost"
											className="text-destructive"
											onClick={() => {
												if (
													window.confirm(
														`Delete “${draft.name}”? Existing videos and queued edits keep their saved branding.`,
													)
												)
													void persist({
														type: "remove",
														kitId: draft.id,
													}).then((data) => {
														if (data) {
															setDraft(null);
															setNotice("Brand Kit deleted");
														}
													});
											}}
										>
											<Trash2 />
											<UiMessage text={"Delete"} />
										</Button>
									)}
								</div>
							</fieldset>
							<aside className="space-y-3">
								<p className="text-xs uppercase tracking-widest text-muted-foreground">
									<UiMessage text={"Brand preview"} />
								</p>
								<div
									className="relative flex aspect-[9/16] flex-col items-center justify-center overflow-hidden rounded-2xl border p-7 text-center shadow-sm"
									style={{
										background: draft.backgroundColor,
										color: draft.primaryColor,
									}}
								>
									{logoUrl && (
										<img
											className="absolute right-5 top-6 max-h-16 max-w-28 object-contain"
											src={accountAssetUrl(logoUrl)}
											alt={`${draft.name || "Brand"} logo`}
										/>
									)}
									<div
										className="mb-4 h-1 w-10 rounded"
										style={{ background: draft.secondaryColor }}
									/>
									<h2
										className="text-3xl font-bold"
										style={{ fontFamily: draft.headingFont }}
									>
										{draft.name || <UiMessage text={"Your brand"} />}
									</h2>
									<p
										className="mt-5 text-lg"
										style={{ fontFamily: draft.bodyFont }}
									>
										<UiMessage text={"A consistent voice."} />
										<br />
										<span style={{ color: draft.secondaryColor }}>
											<UiMessage text={"In every video."} />
										</span>
									</p>
									<p
										className="absolute bottom-10 left-6 right-6 text-sm"
										style={{
											fontFamily: draft.headingFont,
											color: draft.secondaryColor,
										}}
									>
										{draft.phrases[0] || (
											<UiMessage text={"Your closing phrase"} />
										)}
									</p>
								</div>
								<p className="text-xs leading-relaxed text-muted-foreground">
									<UiMessage
										text={
											"Preview of your palette and typography. Full Auto Edit adds editable branding; footage and captions determine the final layout."
										}
									/>
								</p>
							</aside>
						</form>
					) : (
						<div className="grid min-h-96 place-content-center rounded-2xl border border-dashed p-10 text-center">
							<Palette className="mx-auto mb-4 size-10 text-muted-foreground" />
							<h2 className="text-xl font-medium">
								<UiMessage text={"Make a brand feel familiar."} />
							</h2>
							<p className="mt-2 text-sm text-muted-foreground">
								<UiMessage
									text={"Choose a kit or create one for your next client."}
								/>
							</p>
							<Button
								className={`mx-auto mt-5 ${brand.primary}`}
								onClick={() => select(newBrandKit())}
							>
								<Plus />
								<UiMessage text={"Create Brand Kit"} />
							</Button>
						</div>
					)}
				</div>
			)}
		</section>
	);
}
