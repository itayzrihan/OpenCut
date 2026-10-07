import { MAX_FEATHER } from "@/masks/feather";
import type { ParamDefinition } from "@/params";
import type {
	BaseMaskParams,
	Mask,
	MaskDefaultContext,
	MaskDefinition,
	MaskParamUpdateArgs,
	MaskRenderer,
	MaskType,
} from "@/masks/types";
import type { HugeiconsIconProps } from "@hugeicons/react";
import { DefinitionRegistry } from "@/params/registry";

export type MaskIconProps = {
	icon: HugeiconsIconProps["icon"];
	strokeWidth?: number;
};

type RegisteredMaskWithoutId = Mask extends infer TMask
	? TMask extends Mask
		? Omit<TMask, "id">
		: never
	: never;

export type MaskDefinitionForRegistration = {
	[TType in MaskType]: MaskDefinition<TType>;
}[MaskType];

export const BASE_MASK_PARAM_DEFINITIONS: ParamDefinition<
	keyof BaseMaskParams & string
>[] = [
	{
		key: "feather",
		label: "Feather",
		type: "number",
		default: 0,
		min: 0,
		max: MAX_FEATHER,
		step: 1,
		unit: "percent",
	},
	{
		key: "strokeWidth",
		label: "Stroke width",
		type: "number",
		default: 0,
		min: 0,
		max: 100,
		step: 1,
	},
	{
		key: "strokeColor",
		label: "Stroke color",
		type: "color",
		default: "#ffffff",
	},
];

export interface RegisteredMaskDefinition {
	defaultSizing?: MaskDefinition["defaultSizing"];
	type: MaskType;
	name: string;
	features: MaskDefinition["features"];
	params: ParamDefinition<string>[];
	renderer: MaskRenderer<BaseMaskParams>;
	interaction: MaskDefinition["interaction"];
	isActive?(params: BaseMaskParams): boolean;
	buildDefault(context: MaskDefaultContext): RegisteredMaskWithoutId;
	computeParamUpdate(
		args: MaskParamUpdateArgs<BaseMaskParams>,
	): Partial<BaseMaskParams>;
	icon: MaskIconProps;
}

export class MasksRegistry extends DefinitionRegistry<
	MaskType,
	RegisteredMaskDefinition
> {
	private listeners = new Set<(definitions: MaskCatalogDefinition[]) => void>();
	constructor() {
		super("mask");
	}

	override register(input: {
		key: MaskType;
		definition: RegisteredMaskDefinition;
	}): void {
		if (input.key !== input.definition.type)
			throw new Error("Mask registry key must match type");
		const previous = this.catalog();
		const next = this.getAll();
		const index = next.findIndex((d) => d.type === input.key);
		if (index < 0) next.push(input.definition);
		else next[index] = input.definition;
		const descriptions = next.map(describeMask);
		try {
			for (const listener of this.listeners) listener(descriptions);
		} catch (error) {
			for (const listener of this.listeners) {
				try {
					listener(previous);
				} catch {
					/* host rejected atomically */
				}
			}
			throw error;
		}
		super.register(input);
	}

	catalog(): MaskCatalogDefinition[] {
		return this.getAll().map(describeMask);
	}
	subscribe(
		listener: (definitions: MaskCatalogDefinition[]) => void,
	): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	registerMask({
		definition,
		icon,
	}: {
		definition: MaskDefinitionForRegistration;
		icon: MaskIconProps;
	}): void {
		const withBaseParams: RegisteredMaskDefinition = {
			defaultSizing: definition.defaultSizing,
			type: definition.type,
			name: definition.name,
			features: definition.features,
			params: [...definition.params, ...BASE_MASK_PARAM_DEFINITIONS],
			renderer: definition.renderer,
			interaction: definition.interaction,
			isActive: definition.isActive,
			buildDefault: definition.buildDefault,
			computeParamUpdate: definition.computeParamUpdate,
			icon,
		};
		this.register({
			key: definition.type,
			definition: withBaseParams,
		});
	}
}

export type MaskCatalogDefinition = {
	type: string;
	name: string;
	features: MaskDefinition["features"];
	params: ParamDefinition<string>[];
	defaults: Mask["params"];
	defaultSizing: "fixed" | "square" | "diagonal";
};
function describeMask(
	definition: RegisteredMaskDefinition,
): MaskCatalogDefinition {
	return {
		type: definition.type,
		name: definition.name,
		features: definition.features,
		params: definition.params,
		defaults: definition.buildDefault({}).params,
		defaultSizing: definition.defaultSizing ?? "fixed",
	};
}

export const masksRegistry = new MasksRegistry();
