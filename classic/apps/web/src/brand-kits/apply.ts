/** Host asset preflight. Rust owns every timeline/style transformation. */
import type { EditorCore } from "@/core";
import type { ProjectFont } from "@/fonts/types";
import type { BrandKit } from "./types";
import { sharedLibraryService } from "@/shared-library/service";
import { storageService } from "@/services/storage/service";
import { loadProjectFont, isProjectFontLoaded } from "@/fonts/custom-fonts";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";

export async function prepareBrandKit({
	editor,
	kit,
	signal,
	assertContext,
}: {
	editor: EditorCore;
	kit: BrandKit;
	signal: AbortSignal;
	assertContext: () => void;
}): Promise<Record<string, number>> {
	assertContext();
	const projectId = editor.project.getActive().metadata.id;
	if (
		kit.logo &&
		!(await sharedLibraryService.getStickerAssetFile({ id: kit.logo.assetId }))
	)
		throw new Error(
			"Brand logo is unavailable; update this Brand Kit before editing",
		);
	if (
		kit.logo &&
		!(await sharedLibraryService.getStickerAssetDataUrl({
			id: kit.logo.assetId,
		}))
	)
		throw new Error(
			"Brand logo has no renderable resource; import it again before editing",
		);
	const sounds = await sharedLibraryService.listAudioAssets();
	const sfxDurationTicks: Record<string, number> = {};
	for (const id of [...kit.musicIds, ...kit.sfxIds]) {
		signal.throwIfAborted();
		assertContext();
		const sound = sounds.find((asset) => asset.id === id);
		if (
			!sound ||
			sound.folder !== (kit.musicIds.includes(id) ? "music" : "sfx") ||
			!(await sharedLibraryService.getAudioAssetFile({ id }))
		)
			throw new Error(
				"A Brand Kit sound is unavailable; update this kit before editing",
			);
		if (kit.sfxIds.includes(id)) {
			if (
				!sound.duration ||
				!Number.isFinite(sound.duration) ||
				sound.duration <= 0
			)
				throw new Error(
					"Brand SFX needs a known duration. Import the sound again.",
				);
			sfxDurationTicks[id] = Math.round(sound.duration * 120000);
		}
	}
	const fonts = await storageService.loadAllSharedFonts();
	const preparedFonts: ProjectFont[] = [];
	for (const family of new Set([kit.headingFont, kit.bodyFont])) {
		if (SYSTEM_FONTS.has(family)) continue;
		const font = fonts.find((font) => font.family === family);
		if (!font)
			throw new Error(
				`Brand font “${family}” is unavailable; upload it in Brand Kits`,
			);
		await loadProjectFont({ font });
		if (!isProjectFontLoaded({ family }))
			throw new Error(`Brand font “${family}” could not load`);
		assertContext();
		await storageService.saveProjectFont({ projectId, font });
		const { file: _file, url: _url, ...metadata } = font;
		preparedFonts.push(metadata);
	}
	assertContext();
	if (preparedFonts.length)
		editor.command.executeTransaction({
			execute: () => {
				const project = editor.project.getActive();
				const merged = new Map(
					(project.customFonts ?? []).map((font) => [font.family, font]),
				);
				for (const font of preparedFonts) merged.set(font.family, font);
				editor.project.setActiveProject({
					project: { ...project, customFonts: [...merged.values()] },
				});
				editor.save.markDirty();
			},
		});
	return sfxDurationTicks;
}
export function applyBrandKit({
	editor,
	kit,
	sfxDurationTicks,
}: {
	editor: EditorCore;
	kit: BrandKit;
	sfxDurationTicks: Record<string, number>;
}) {
	const accountId = window.__opencutAccountId;
	if (!accountId) throw new Error("Brand Kit account is no longer active");
	return editor.command.invokeCanonicalControl({
		accountId,
		projectId: editor.project.getActive().metadata.id,
		capabilityId: "timeline.classic.brand_kit.apply",
		input: {
			sceneId: editor.scenes.getActiveScene().id,
			kit,
			sfxDurationTicks,
		},
	});
}
