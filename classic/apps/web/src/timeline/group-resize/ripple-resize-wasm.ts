import * as wasm from "opencut-wasm";

export const rippleResizeWasm = {
	rippleInsertTime: (options: Parameters<typeof wasm.rippleInsertTime>[0]) =>
		wasm.rippleInsertTime(options),
};
