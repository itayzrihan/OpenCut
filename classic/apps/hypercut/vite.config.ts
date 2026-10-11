import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { getHyperframeRuntimeScript } from "@hyperframes/core/runtime-script";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
function runtimeAssets(): Plugin {
	const assets: Record<string, string> = {
		"hyperframes-runtime.js": getHyperframeRuntimeScript(),
		"gsap.min.js": readFileSync(
			require.resolve("gsap/dist/gsap.min.js"),
			"utf8",
		),
	};
	return {
		name: "hypercut-runtime-assets",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const asset = assets[req.url?.slice(1) ?? ""];
				if (!asset) return next();
				res.setHeader("Content-Type", "text/javascript");
				res.end(asset);
			});
		},
		generateBundle() {
			this.emitFile({ type: "asset", fileName: "licenses/hyperframes.txt", source: readFileSync(new URL("./third-party/hyperframes-LICENSE", import.meta.url), "utf8") });
			for (const [fileName, source] of Object.entries(assets))
				this.emitFile({ type: "asset", fileName, source });
		},
	};
}
export default defineConfig({
	plugins: [react(), runtimeAssets()],
	worker: { format: "es" },
	build: { target: "es2022" },
	server: { fs: { allow: ["../.."] }, proxy: { "/api": { target: "http://127.0.0.1:3221", changeOrigin: false } } },
});
