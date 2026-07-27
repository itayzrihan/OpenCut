import type { ParamDefinition } from "@/params";

export function shouldUseLiveElementParamPlayhead({
	params,
	isBulk,
	isScopedText,
}: {
	params: readonly Pick<ParamDefinition, "keyframable">[];
	isBulk: boolean;
	isScopedText: boolean;
}): boolean {
	if (isBulk || isScopedText) {
		return false;
	}

	return params.some((param) => param.keyframable !== false);
}
