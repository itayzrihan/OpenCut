import { DefinitionRegistry } from "@/params/registry";
import type { EffectDefinition } from "@/effects/types";

export class EffectsRegistry extends DefinitionRegistry<
	string,
	EffectDefinition
> {
	private listeners = new Set<
		(definitions: Array<Omit<EffectDefinition, "renderer">>) => void
	>();
	constructor() {
		super("effect");
	}

	override register(input: {
		key: string;
		definition: EffectDefinition;
	}): void {
		if (input.key !== input.definition.type)
			throw new Error("Effect registry key must match its type");
		const previous = this.catalog();
		const next = this.getAll();
		const index = next.findIndex((definition) => definition.type === input.key);
		if (index < 0) next.push(input.definition);
		else next[index] = input.definition;
		const descriptions = next.map(
			({ renderer: _renderer, ...definition }) => definition,
		);
		try {
			for (const listener of this.listeners) listener(descriptions);
		} catch (error) {
			// Restore already-notified hosts if one rejects a definition or refuses
			// a catalog change during a transaction. The UI registry stays intact.
			for (const listener of this.listeners) {
				try {
					listener(previous);
				} catch {
					/* rejecting host retained its old catalog */
				}
			}
			throw error;
		}
		super.register(input);
	}

	subscribe(
		listener: (definitions: Array<Omit<EffectDefinition, "renderer">>) => void,
	): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Publish descriptions only; renderer functions remain owned by the host. */
	catalog(): Array<Omit<EffectDefinition, "renderer">> {
		return this.getAll().map(
			({ renderer: _renderer, ...definition }) => definition,
		);
	}
}

export const effectsRegistry = new EffectsRegistry();
