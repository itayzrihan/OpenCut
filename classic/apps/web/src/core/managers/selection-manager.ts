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

	constructor(editor: EditorCore) {
		void editor;
	}

	getSelectedElements(): ElementRef[] {
		return this.selectedElements;
	}

	getSelectedTextWords(): SelectedTextWordRef[] {
		return this.selectedTextWords;
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
			selectedElements: [...this.selectedElements],
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
		this.selectedElements = elements;
		this.selectedTextWords = [];
		this.selectedKeyframes = [];
		this.keyframeSelectionAnchor = null;
		this.selectedMaskPoints = null;
		this.notify();
	}

	setSelectedTextWords({ words }: { words: SelectedTextWordRef[] }): void {
		this.selectedElements = this.getElementsForTextWords({ words });
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
		this.selectedElements = [];
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
		if (patch.selectedElements !== undefined) {
			this.selectedElements = [...patch.selectedElements];
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
		this.selectedElements = [...snapshot.selectedElements];
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
		this.listeners.forEach((fn) => {
			fn();
		});
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
