import { toast } from "sonner";
import { create } from "zustand";
import { sharedLibraryService } from "./service";
import type {
	GeneratedBackgroundPreset,
	GeneratedEffectPreset,
	SharedAssetCategory,
	SharedAudioAsset,
	SharedAudioFolder,
	SharedCategoryScope,
	SharedStickerAsset,
} from "./types";

interface SharedLibraryStore {
	audioAssets: SharedAudioAsset[];
	stickerAssets: SharedStickerAsset[];
	categories: SharedAssetCategory[];
	generatedBackgrounds: GeneratedBackgroundPreset[];
	generatedEffects: GeneratedEffectPreset[];
	isLoading: boolean;
	error: string | null;

	loadLibrary: () => Promise<void>;
	importAudioFiles: (args: {
		files: File[];
		folder: SharedAudioFolder;
	}) => Promise<SharedAudioAsset[]>;
	importStickerFiles: (args: { files: File[] }) => Promise<SharedStickerAsset[]>;
	createCategory: (args: {
		scope: SharedCategoryScope;
		name: string;
	}) => Promise<SharedAssetCategory | null>;
	addAssetToCategory: (args: {
		categoryId: string;
		assetId: string;
	}) => Promise<void>;
	saveGeneratedBackground: (
		args: Omit<GeneratedBackgroundPreset, "id" | "createdAt" | "updatedAt">,
	) => Promise<GeneratedBackgroundPreset | null>;
	saveGeneratedEffect: (
		args: Omit<GeneratedEffectPreset, "id" | "createdAt" | "updatedAt">,
	) => Promise<GeneratedEffectPreset | null>;
}

function messageFromError({
	error,
	fallback,
}: {
	error: unknown;
	fallback: string;
}): string {
	return error instanceof Error ? error.message : fallback;
}

export const useSharedLibraryStore = create<SharedLibraryStore>((set) => ({
	audioAssets: [],
	stickerAssets: [],
	categories: [],
	generatedBackgrounds: [],
	generatedEffects: [],
	isLoading: false,
	error: null,

	loadLibrary: async () => {
		try {
			set({ isLoading: true, error: null });
			const [
				audioAssets,
				stickerAssets,
				categories,
				generatedBackgrounds,
				generatedEffects,
			] = await Promise.all([
				sharedLibraryService.listAudioAssets(),
				sharedLibraryService.listStickerAssets(),
				sharedLibraryService.listCategories(),
				sharedLibraryService.listGeneratedBackgrounds(),
				sharedLibraryService.listGeneratedEffects(),
			]);
			await sharedLibraryService.warmStickerCache();
			set({
				audioAssets,
				stickerAssets,
				categories,
				generatedBackgrounds,
				generatedEffects,
				isLoading: false,
			});
		} catch (error) {
			const message = messageFromError({
				error,
				fallback: "Failed to load shared library",
			});
			set({ error: message, isLoading: false });
			console.error("Failed to load shared library:", error);
		}
	},

	importAudioFiles: async ({ files, folder }) => {
		try {
			const imported = await sharedLibraryService.importAudioFiles({
				files,
				folder,
			});
			set((state) => ({
				audioAssets: [...imported, ...state.audioAssets],
			}));
			if (imported.length > 0) {
				toast.success(
					`Added ${imported.length} ${imported.length === 1 ? "sound" : "sounds"}`,
				);
			}
			return imported;
		} catch (error) {
			const message = messageFromError({
				error,
				fallback: "Failed to import audio",
			});
			toast.error(message);
			console.error("Failed to import audio:", error);
			return [];
		}
	},

	importStickerFiles: async ({ files }) => {
		try {
			const imported = await sharedLibraryService.importStickerFiles({ files });
			set((state) => ({
				stickerAssets: [...imported, ...state.stickerAssets],
			}));
			if (imported.length > 0) {
				toast.success(
					`Added ${imported.length} ${imported.length === 1 ? "sticker" : "stickers"}`,
				);
			}
			return imported;
		} catch (error) {
			const message = messageFromError({
				error,
				fallback: "Failed to import stickers",
			});
			toast.error(message);
			console.error("Failed to import stickers:", error);
			return [];
		}
	},

	createCategory: async ({ scope, name }) => {
		try {
			const category = await sharedLibraryService.createCategory({
				scope,
				name,
			});
			set((state) => ({ categories: [...state.categories, category] }));
			return category;
		} catch (error) {
			const message = messageFromError({
				error,
				fallback: "Failed to create category",
			});
			toast.error(message);
			console.error("Failed to create category:", error);
			return null;
		}
	},

	addAssetToCategory: async ({ categoryId, assetId }) => {
		try {
			const updated = await sharedLibraryService.addAssetToCategory({
				categoryId,
				assetId,
			});
			if (!updated) return;
			set((state) => ({
				categories: state.categories.map((category) =>
					category.id === updated.id ? updated : category,
				),
			}));
		} catch (error) {
			const message = messageFromError({
				error,
				fallback: "Failed to update category",
			});
			toast.error(message);
			console.error("Failed to update category:", error);
		}
	},

	saveGeneratedBackground: async (args) => {
		try {
			const preset = await sharedLibraryService.saveGeneratedBackground(args);
			set((state) => ({
				generatedBackgrounds: [preset, ...state.generatedBackgrounds],
			}));
			return preset;
		} catch (error) {
			const message = messageFromError({
				error,
				fallback: "Failed to save background",
			});
			toast.error(message);
			console.error("Failed to save generated background:", error);
			return null;
		}
	},

	saveGeneratedEffect: async (args) => {
		try {
			const preset = await sharedLibraryService.saveGeneratedEffect(args);
			set((state) => ({
				generatedEffects: [preset, ...state.generatedEffects],
			}));
			return preset;
		} catch (error) {
			const message = messageFromError({
				error,
				fallback: "Failed to save effect",
			});
			toast.error(message);
			console.error("Failed to save generated effect:", error);
			return null;
		}
	},
}));
