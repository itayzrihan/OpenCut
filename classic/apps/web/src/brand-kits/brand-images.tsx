"use client";

import { useId, useState } from "react";
import { Image as ImageIcon, ImageOff, Plus, Upload, X } from "lucide-react";
import { accountAssetUrl } from "@/accounts/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useInterfaceLanguage } from "@/i18n/provider";
import type { SharedStickerAsset } from "@/shared-library/types";
import {
	BRAND_IMAGE_MIME_TYPES,
	MAX_BRAND_IMAGES,
	MAX_BRAND_IMAGE_TAGS,
	MAX_BRAND_IMAGE_TAG_BYTES,
	type BrandImage,
} from "./types";

export function BrandImages({
	images,
	assets,
	onUpload,
	onChange,
}: {
	images: BrandImage[];
	assets: SharedStickerAsset[];
	onUpload: (files: File[]) => void;
	onChange: (images: BrandImage[]) => void;
}) {
	const { t } = useInterfaceLanguage();
	const headingId = useId();
	const [search, setSearch] = useState("");
	const query = search.trim().toLowerCase();
	const matches = images.filter((image) =>
		[image.name, ...image.tags].some((text) =>
			text.toLowerCase().includes(query),
		),
	);
	return (
		<section
			aria-labelledby={headingId}
			className="space-y-4 rounded-xl border bg-card/75 p-5"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<h3 id={headingId} className="flex items-center gap-2 font-semibold">
						<ImageIcon
							className="size-4 shrink-0 text-primary"
							aria-hidden="true"
						/>
						{t("Characters & brand images")}
					</h3>
					<p className="text-sm text-muted-foreground">
						{t(
							"Save reference images, give them names, and use tags to find them again.",
						)}
					</p>
				</div>
				<label className="inline-flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted focus-within:ring-2 focus-within:ring-ring has-disabled:cursor-not-allowed has-disabled:opacity-50">
					<Upload className="size-4" aria-hidden="true" />
					{t("Upload images")}
					<input
						type="file"
						aria-label={t("Upload images")}
						className="sr-only"
						accept={BRAND_IMAGE_MIME_TYPES.join(",")}
						multiple
						disabled={images.length >= MAX_BRAND_IMAGES}
						onChange={(event) => {
							const files = Array.from(event.currentTarget.files ?? []);
							event.currentTarget.value = "";
							onUpload(files);
						}}
					/>
				</label>
			</div>
			{images.length > 0 && (
				<Input
					type="search"
					aria-label={t("Search images by name or tag")}
					placeholder={t("Search images by name or tag")}
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			)}
			{matches.length > 0 ? (
				<div className="grid gap-3 sm:grid-cols-2">
					{matches.map((image) => (
						<BrandImageCard
							key={image.assetId}
							image={image}
							source={
								assets.find((asset) => asset.id === image.assetId)?.sourceUrl
							}
							onUpdate={(patch) =>
								onChange(
									images.map((entry) =>
										entry.assetId === image.assetId
											? { ...entry, ...patch }
											: entry,
									),
								)
							}
							onRemove={() =>
								onChange(
									images.filter((entry) => entry.assetId !== image.assetId),
								)
							}
						/>
					))}
				</div>
			) : (
				<p className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">
					{images.length
						? t("No matching images")
						: t(
								"Upload a character portrait, product photo, or other brand reference.",
							)}
				</p>
			)}
		</section>
	);
}

function BrandImageCard({
	image,
	source,
	onUpdate,
	onRemove,
}: {
	image: BrandImage;
	source?: string;
	onUpdate: (
		patch: Partial<Pick<BrandImage, "name" | "kind" | "tags">>,
	) => void;
	onRemove: () => void;
}) {
	const { t } = useInterfaceLanguage();
	const id = useId();
	const [brokenSource, setBrokenSource] = useState<string>();
	const [tagInput, setTagInput] = useState("");
	const [tagError, setTagError] = useState("");
	function addTag() {
		const tag = tagInput.trim();
		if (!tag) return;
		if (image.tags.length >= MAX_BRAND_IMAGE_TAGS) {
			setTagError(t("An image can have up to 12 tags"));
			return;
		}
		if (
			new TextEncoder().encode(tag).length > MAX_BRAND_IMAGE_TAG_BYTES ||
			/\p{Cc}/u.test(tag)
		) {
			setTagError(t("Image tags must be non-empty and at most 96 bytes"));
			return;
		}
		if (
			!image.tags.some(
				(existing) => existing.toLowerCase() === tag.toLowerCase(),
			)
		) {
			onUpdate({ tags: [...image.tags, tag] });
		}
		setTagInput("");
		setTagError("");
	}
	return (
		<article className="min-w-0 overflow-hidden rounded-lg border bg-background/70">
			<div className="relative grid aspect-video place-items-center overflow-hidden bg-muted/45">
				{source && source !== brokenSource ? (
					<img
						className="size-full object-contain"
						src={accountAssetUrl(source)}
						alt={image.name}
						loading="lazy"
						onError={() => setBrokenSource(source)}
					/>
				) : (
					<div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
						<ImageOff className="size-4" aria-hidden="true" />{" "}
						{t("Image unavailable")}
					</div>
				)}
				<Button
					type="button"
					size="icon"
					variant="outline"
					className="absolute end-2 top-2 size-8 bg-background"
					aria-label={t("Remove image from kit")}
					onClick={onRemove}
				>
					<X className="size-4" aria-hidden="true" />
				</Button>
			</div>
			<div className="space-y-3 p-3">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
					<label className="grid min-w-0 gap-1.5 text-xs font-medium">
						{t("Image name")}
						<Input
							required
							maxLength={64}
							dir="auto"
							value={image.name}
							onChange={(event) => onUpdate({ name: event.target.value })}
						/>
					</label>
					<div className="grid gap-1.5 text-xs font-medium">
						<label htmlFor={`${id}-type`}>{t("Image type")}</label>
						<select
							id={`${id}-type`}
							className="h-9 rounded-md border bg-background px-2 text-sm"
							value={image.kind}
							onChange={(event) =>
								onUpdate({
									kind:
										event.target.value === "character" ? "character" : "image",
								})
							}
						>
							<option value="image">{t("Image")}</option>
							<option value="character">{t("Character")}</option>
						</select>
					</div>
				</div>
				<div className="space-y-1.5">
					<label htmlFor={`${id}-tag`} className="text-xs font-medium">
						{t("Tags")}
					</label>
					<div className="flex gap-2">
						<Input
							id={`${id}-tag`}
							className="min-w-0"
							dir="auto"
							maxLength={96}
							value={tagInput}
							placeholder={t("Add a tag")}
							onChange={(event) => {
								setTagInput(event.target.value);
								setTagError("");
							}}
							onKeyDown={(event) => {
								if (
									event.nativeEvent.isComposing ||
									!["Enter", ","].includes(event.key)
								)
									return;
								event.preventDefault();
								addTag();
							}}
						/>
						<Button
							type="button"
							size="icon"
							variant="outline"
							aria-label={t("Add a tag")}
							disabled={!tagInput.trim()}
							onClick={addTag}
						>
							<Plus className="size-4" aria-hidden="true" />
						</Button>
					</div>
					{tagError && (
						<p role="alert" className="text-xs text-destructive">
							{tagError}
						</p>
					)}
					{image.tags.length > 0 && (
						<ul className="flex flex-wrap gap-1.5">
							{image.tags.map((tag) => (
								<li
									key={tag}
									className="inline-flex max-w-full items-center gap-1 rounded-full border bg-primary/10 px-2 py-1 text-xs"
								>
									<bdi className="break-all">{tag}</bdi>
									<button
										type="button"
										aria-label={t("Remove {v0}", { v0: tag })}
										className="shrink-0 rounded-full p-0.5 hover:bg-primary/20 focus-visible:ring-2"
										onClick={() =>
											onUpdate({
												tags: image.tags.filter((value) => value !== tag),
											})
										}
									>
										<X className="size-3" aria-hidden="true" />
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</article>
	);
}
