import { toast } from "@/i18n/toast";

export interface MediaUploadToastResult {
	uploadedCount: number;
	assetNames?: string[];
}

function getAssetLabel({ count }: { count: number }): string {
	return count === 1 ? "media asset" : "media assets";
}

function waitForNextPaint(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => resolve());
		});
	});
}

export async function showMediaUploadToast<T extends MediaUploadToastResult>({
	filesCount,
	promise,
}: {
	filesCount: number;
	promise: Promise<T> | (() => Promise<T>);
}) {
	const run = typeof promise === "function" ? promise : () => promise;
	const toastPromise = toast.promise(
		async () => {
			await waitForNextPaint();
			return run();
		},
		{
			loading: `Importing ${getAssetLabel({ count: filesCount })}...`,
			success: ({ uploadedCount, assetNames }) => {
				if (uploadedCount === 1) {
					const assetName = assetNames?.[0];
					return assetName
						? `Imported ${assetName}`
						: "Imported 1 media asset";
				}

				if (uploadedCount > 1) {
					return `Imported ${uploadedCount} media assets`;
				}

				return "No media assets were imported";
			},
			error: `Failed to import ${getAssetLabel({ count: filesCount })}`,
		},
	);

	return toastPromise.unwrap();
}
