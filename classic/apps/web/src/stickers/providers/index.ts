import { stickersRegistry } from "../registry";
import type { StickerProvider } from "@/stickers/types";
import { builtinStickersProvider } from "./builtins";
import { flagsProvider } from "./flags";
import { logosProvider } from "./logos";
import { shapesProvider } from "./shapes";
import { userStickersProvider } from "./user-stickers";

const defaultProviders: StickerProvider[] = [
	builtinStickersProvider,
	logosProvider,
	flagsProvider,
	shapesProvider,
	userStickersProvider,
];

export function registerDefaultStickerProviders({
	providersToRegister = defaultProviders,
}: {
	providersToRegister?: StickerProvider[];
} = {}): void {
	for (const provider of providersToRegister) {
		if (stickersRegistry.has(provider.id)) {
			continue;
		}
		stickersRegistry.register({ key: provider.id, definition: provider });
	}
}
