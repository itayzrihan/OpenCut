import { BaseNode } from "./base-node";

export type ColorNodeParams = {
	color: string;
	screenLocked?: boolean;
};

export class ColorNode extends BaseNode<ColorNodeParams> {}
