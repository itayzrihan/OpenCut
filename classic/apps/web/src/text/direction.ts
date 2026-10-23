import { resolveTextDirection } from "opencut-wasm";

export function resolveAutoTextDirection(text: string): "ltr" | "rtl" {
	return resolveTextDirection({ text, fallback: "ltr" });
}
