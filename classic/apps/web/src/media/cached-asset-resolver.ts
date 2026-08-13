export function createCachedAssetResolver<
	TAsset extends { id: string },
	TResult,
>({
	resolve,
}: {
	resolve: (options: { asset: TAsset }) => Promise<TResult>;
}): (options: { asset: TAsset }) => Promise<TResult> {
	const pendingByAssetId = new Map<string, Promise<TResult>>();

	return ({ asset }) => {
		const cached = pendingByAssetId.get(asset.id);
		if (cached) return cached;

		const pending = resolve({ asset });
		pendingByAssetId.set(asset.id, pending);
		return pending;
	};
}
