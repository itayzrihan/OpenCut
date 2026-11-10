import type { EditorCore } from "@/core";
import type { SelectedKeyframeRef } from "@/animation/types";
import type {
	EditorSelectionKind,
	EditorSelectionPatch,
	EditorSelectionSnapshot,
	SelectedMaskPointSelection,
	SelectedTextWordRef,
} from "@/selection/editor-selection";
import type { ElementRef } from "@/timeline/types";

export class SelectionManager {
	private selectedElements: ElementRef[] = [];
	private selectedTextWords: SelectedTextWordRef[] = [];
	private selectedKeyframes: SelectedKeyframeRef[] = [];
	private keyframeSelectionAnchor: SelectedKeyframeRef | null = null;
	private selectedMaskPoints: SelectedMaskPointSelection | null = null;
	private listeners = new Set<() => void>();
	private pendingElements = false;
	private pendingPreserveScope = false;
	private canonicalScope = "";
	private canonicalSelectionRevision = -1;

	constructor(private editor: EditorCore) {}

	getSelectedElements(): ElementRef[] {
		if (!this.pendingElements) this.readCanonicalProjection();
		return this.selectedElements;
	}

	getSelectedTextWords(): SelectedTextWordRef[] {
		return this.selectedTextWords;
	}

	getExactTrackSelectionId(): string | null {
		return this.editor.command?.readClassicSelection?.()?.exactTrackId ?? null;
	}

	getSelectedKeyframes(): SelectedKeyframeRef[] {
		return this.selectedKeyframes;
	}

	getKeyframeSelectionAnchor(): SelectedKeyframeRef | null {
		return this.keyframeSelectionAnchor;
	}

	getSelectedMaskPointSelection(): SelectedMaskPointSelection | null {
		return this.selectedMaskPoints;
	}

	getActiveSelectionKind(): EditorSelectionKind | null {
		this.getSelectedElements();
		if ((this.selectedMaskPoints?.pointIds.length ?? 0) > 0) {
			return "mask-points";
		}
		if (this.selectedKeyframes.length > 0) {
			return "keyframes";
		}
		if (this.selectedTextWords.length > 0) {
			return "text-words";
		}
		if (this.selectedElements.length > 0) {
			return "elements";
		}
		return null;
	}

	getSnapshot(): EditorSelectionSnapshot {
		return {
			selectedElements: [...this.getSelectedElements()],
			selectedTextWords: [...this.selectedTextWords],
			selectedKeyframes: [...this.selectedKeyframes],
			keyframeSelectionAnchor: this.keyframeSelectionAnchor,
			selectedMaskPoints: this.selectedMaskPoints
				? {
						...this.selectedMaskPoints,
						pointIds: [...this.selectedMaskPoints.pointIds],
					}
				: null,
		};
	}

	setSelectedElements({ elements }: { elements: ElementRef[] }): void {
		this.pendingPreserveScope = false;
		this.selectedElements = elements;
		this.pendingElements = true;
		this.selectedTextWords = [];
		this.selectedKeyframes = [];
		this.keyframeSelectionAnchor = null;
		this.selectedMaskPoints = null;
		this.notify();
	}

	setSelectedTextWords({ words }: { words: SelectedTextWordRef[] }): void {
		this.getSelectedElements();
		this.selectedElements = this.getElementsForTextWords({ words });
		this.pendingElements = true;
		this.selectedTextWords = words;
		this.selectedKeyframes = [];
		this.keyframeSelectionAnchor = null;
		this.selectedMaskPoints = null;
		this.notify();
	}

	setSelectedKeyframes({
		keyframes,
		anchorKeyframe,
	}: {
		keyframes: SelectedKeyframeRef[];
		anchorKeyframe?: SelectedKeyframeRef | null;
	}): void {
		this.getSelectedElements();
		this.selectedKeyframes = keyframes;
		if (anchorKeyframe !== undefined) {
			this.keyframeSelectionAnchor = anchorKeyframe;
		} else if (keyframes.length === 0) {
			this.keyframeSelectionAnchor = null;
		}
		this.selectedTextWords = [];
		this.selectedMaskPoints = null;
		this.notify();
	}

	setSelectedMaskPoints({
		selection,
	}: {
		selection: SelectedMaskPointSelection | null;
	}): void {
		this.getSelectedElements();
		this.selectedMaskPoints =
			selection && selection.pointIds.length > 0
				? {
						...selection,
						pointIds: [...selection.pointIds],
					}
				: null;
		this.selectedTextWords = [];
		this.selectedKeyframes = [];
		this.keyframeSelectionAnchor = null;
		this.notify();
	}

	clearSelection(): void {
		this.pendingPreserveScope = false;
		this.selectedElements = [];
		this.pendingElements = true;
		this.selectedTextWords = [];
		this.selectedKeyframes = [];
		this.keyframeSelectionAnchor = null;
		this.selectedMaskPoints = null;
		this.notify();
	}

	clearKeyframeSelection(): void {
		this.selectedKeyframes = [];
		this.keyframeSelectionAnchor = null;
		this.notify();
	}

	clearMaskPointSelection(): void {
		if (!this.selectedMaskPoints) {
			return;
		}
		this.selectedMaskPoints = null;
		this.notify();
	}

	clearMostSpecificSelection(): boolean {
		const activeSelectionKind = this.getActiveSelectionKind();
		if (activeSelectionKind === "mask-points") {
			this.clearMaskPointSelection();
			return true;
		}
		if (activeSelectionKind === "keyframes") {
			this.clearKeyframeSelection();
			return true;
		}
		if (activeSelectionKind === "text-words") {
			this.setSelectedTextWords({ words: [] });
			return true;
		}
		if (activeSelectionKind === "elements") {
			this.setSelectedElements({ elements: [] });
			return true;
		}
		return false;
	}

	applySelectionPatch({
		patch,
	}: {
		patch: EditorSelectionPatch;
	}): EditorSelectionSnapshot {
		this.getSelectedElements();
		if (patch.selectedElements !== undefined) {
			this.selectedElements = [...patch.selectedElements];
			this.pendingElements = true;
			if (patch.selectedTextWords === undefined) {
				this.selectedTextWords = [];
			}
		}
		if (patch.selectedTextWords !== undefined) {
			this.selectedTextWords = [...patch.selectedTextWords];
			if (patch.selectedElements === undefined) {
				this.selectedElements = this.getElementsForTextWords({
					words: this.selectedTextWords,
				});
				this.pendingElements = true;
			}
		}
		if (patch.selectedKeyframes !== undefined) {
			this.selectedKeyframes = [...patch.selectedKeyframes];
			if (patch.selectedKeyframes.length > 0) {
				this.selectedTextWords = [];
			}
		}
		if (patch.keyframeSelectionAnchor !== undefined) {
			this.keyframeSelectionAnchor = patch.keyframeSelectionAnchor;
		}
		if (patch.selectedMaskPoints !== undefined) {
			this.selectedMaskPoints = patch.selectedMaskPoints
				? {
						...patch.selectedMaskPoints,
						pointIds: [...patch.selectedMaskPoints.pointIds],
					}
				: null;
			if (patch.selectedMaskPoints) {
				this.selectedTextWords = [];
			}
		}
		this.notify();
		return this.getSnapshot();
	}

	restoreSnapshot({ snapshot }: { snapshot: EditorSelectionSnapshot }): void {
		this.getSelectedElements();
		this.pendingPreserveScope = true;
		this.selectedElements = [...snapshot.selectedElements];
		this.pendingElements = true;
		this.selectedTextWords = [...snapshot.selectedTextWords];
		this.selectedKeyframes = [...snapshot.selectedKeyframes];
		this.keyframeSelectionAnchor = snapshot.keyframeSelectionAnchor;
		this.selectedMaskPoints = snapshot.selectedMaskPoints
			? {
					...snapshot.selectedMaskPoints,
					pointIds: [...snapshot.selectedMaskPoints.pointIds],
				}
			: null;
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.flushCanonicalSelection();
		this.listeners.forEach((fn) => {
			fn();
		});
	}

	/** Flush only after host content transactions have published their new IDs. */
	flushCanonicalSelection(): void {
		if (!this.pendingElements) return;
		const projection = this.editor.command?.writeClassicSelection?.({
			elements: this.selectedElements,
			preserveRowScope: this.pendingPreserveScope,
		});
		if (projection) {
			this.pendingElements = false;
			this.pendingPreserveScope = false;
			this.acceptCanonicalProjection({ projection, preserveSpecific: true });
		} else if (this.editor.command?.getCanonicalRevision?.() === undefined) {
			// Startup and isolated legacy tests have no canonical session yet.
			this.pendingElements = false;
			this.canonicalScope = "";
		} else {
			this.pendingPreserveScope = true;
		}
	}

	refreshCanonicalSelection({
		clearSpecific = false,
	}: { clearSpecific?: boolean } = {}): void {
		const before = this.selectedElements;
		const beforeRevision = this.canonicalSelectionRevision;
		this.pendingElements = false;
		this.pendingPreserveScope = false;
		this.readCanonicalProjection();
		if (clearSpecific) {
			this.selectedTextWords = [];
			this.selectedKeyframes = [];
			this.keyframeSelectionAnchor = null;
			this.selectedMaskPoints = null;
		}
		if (
			before !== this.selectedElements ||
			beforeRevision !== this.canonicalSelectionRevision ||
			clearSpecific
		)
			this.notify();
	}

	private readCanonicalProjection(): void {
		const projection = this.editor.command?.readClassicSelection?.();
		if (projection) this.acceptCanonicalProjection({ projection });
		else if (
			this.canonicalScope &&
			this.editor.command?.getCanonicalRevision?.() === undefined
		) {
			this.canonicalScope = "";
			this.canonicalSelectionRevision = -1;
			this.selectedElements = [];
			this.selectedTextWords = [];
			this.selectedKeyframes = [];
			this.keyframeSelectionAnchor = null;
			this.selectedMaskPoints = null;
		}
	}

	private acceptCanonicalProjection({
		projection,
		preserveSpecific = false,
	}: {
		projection: {
			projectId: string;
			sceneId: string;
			accountId: string;
			selectionRevision: number;
			elements: ElementRef[];
		};
		preserveSpecific?: boolean;
	}): void {
		const scope = JSON.stringify([
			projection.accountId,
			projection.projectId,
			projection.sceneId,
		]);
		const changed =
			scope !== this.canonicalScope ||
			this.selectedElements.length !== projection.elements.length ||
			this.selectedElements.some(
				(value, index) =>
					value.trackId !== projection.elements[index].trackId ||
					value.elementId !== projection.elements[index].elementId,
			);
		if (changed) {
			this.selectedElements = projection.elements;
		}
		if (scope !== this.canonicalScope || (changed && !preserveSpecific)) {
			this.selectedTextWords = [];
			this.selectedKeyframes = [];
			this.keyframeSelectionAnchor = null;
			this.selectedMaskPoints = null;
		}
		this.canonicalScope = scope;
		this.canonicalSelectionRevision = projection.selectionRevision;
	}

	private getElementsForTextWords({
		words,
	}: {
		words: SelectedTextWordRef[];
	}): ElementRef[] {
		const selectedElements = new Map<string, ElementRef>();
		for (const word of words) {
			selectedElements.set(`${word.trackId}:${word.elementId}`, {
				trackId: word.trackId,
				elementId: word.elementId,
			});
		}
		return [...selectedElements.values()];
	}
}
