import {
	BlobSource,
	UrlSource,
	type Source,
	type UrlSourceOptions,
} from "mediabunny";

export interface BrowserMediaSource {
	file?: Blob;
	url?: string;
	urlOptions?: UrlSourceOptions;
}

export function createMediaSource({
	file,
	url,
	urlOptions,
}: BrowserMediaSource): Source {
	if (file) return new BlobSource(file);
	if (url) return new UrlSource(url, urlOptions);
	throw new Error("Media has neither file bytes nor a readable URL");
}
