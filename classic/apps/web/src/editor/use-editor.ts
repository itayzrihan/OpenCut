import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { isEditorSnapshotEqual } from "./snapshot";

const SNAPSHOT_UNSET = Symbol("snapshotUnset");

const subscribeNone = () => () => {};

type EditorSubscribe = (params: {
	editor: EditorCore;
	onChange: () => void;
}) => () => void;

function subscribeToStores({
	editor,
	onChange,
	stores,
}: {
	editor: EditorCore;
	onChange: () => void;
	stores: EditorSubscribe[];
}): () => void {
	const unsubscribers = stores.map((subscribe) =>
		subscribe({ editor, onChange }),
	);
	return () => {
		unsubscribers.forEach((unsubscribe) => {
			unsubscribe();
		});
	};
}

const subscribePlayback: EditorSubscribe = ({ editor, onChange }) =>
	editor.playback.subscribe(onChange);
const subscribeTimeline: EditorSubscribe = ({ editor, onChange }) =>
	editor.timeline.subscribe(onChange);
const subscribeScenes: EditorSubscribe = ({ editor, onChange }) =>
	editor.scenes.subscribe(onChange);
const subscribeProject: EditorSubscribe = ({ editor, onChange }) =>
	editor.project.subscribe(onChange);
const subscribeMedia: EditorSubscribe = ({ editor, onChange }) =>
	editor.media.subscribe(onChange);
const subscribeRenderer: EditorSubscribe = ({ editor, onChange }) =>
	editor.renderer.subscribe(onChange);
const subscribeSelection: EditorSubscribe = ({ editor, onChange }) =>
	editor.selection.subscribe(onChange);
const subscribeDiagnostics: EditorSubscribe = ({ editor, onChange }) =>
	editor.diagnostics.subscribe(onChange);
const subscribeTranscription: EditorSubscribe = ({ editor, onChange }) =>
	editor.transcription.subscribe(onChange);

function useSubscribedEditor<T>({
	selector,
	stores,
}: {
	selector: (editor: EditorCore) => T;
	stores: EditorSubscribe[];
}): T {
	const editor = useMemo(() => EditorCore.getInstance(), []);
	const snapshotCacheRef = useRef<T | typeof SNAPSHOT_UNSET>(SNAPSHOT_UNSET);

	const subscribe = useCallback(
		(onChange: () => void) => subscribeToStores({ editor, onChange, stores }),
		[editor, stores],
	);

	const getSnapshot = useCallback((): T => {
		const next = selector(editor);
		if (
			snapshotCacheRef.current !== SNAPSHOT_UNSET &&
			isEditorSnapshotEqual({
				a: snapshotCacheRef.current,
				b: next,
			})
		) {
			return snapshotCacheRef.current;
		}

		snapshotCacheRef.current = next;
		return next;
	}, [editor, selector]);

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useEditor(): EditorCore;
export function useEditor<T>(selector: (editor: EditorCore) => T): T;
export function useEditor<T>(
	selector?: (editor: EditorCore) => T,
): EditorCore | T {
	const editor = useMemo(() => EditorCore.getInstance(), []);
	const snapshotCacheRef = useRef<T | typeof SNAPSHOT_UNSET>(SNAPSHOT_UNSET);

	const subscribeAll = useCallback(
		(onChange: () => void) => {
			const unsubscribers = [
				editor.playback.subscribe(onChange),
				editor.timeline.subscribe(onChange),
				editor.scenes.subscribe(onChange),
				editor.project.subscribe(onChange),
				editor.media.subscribe(onChange),
				editor.renderer.subscribe(onChange),
				editor.selection.subscribe(onChange),
				editor.clipboard.subscribe(onChange),
				editor.diagnostics.subscribe(onChange),
				editor.transcription.subscribe(onChange),
			];
			return () => {
				unsubscribers.forEach((unsubscribe) => {
					unsubscribe();
				});
			};
		},
		[editor],
	);

	const getSnapshot = useCallback((): EditorCore | T => {
		if (!selector) {
			return editor;
		}

		const next = selector(editor);
		if (
			snapshotCacheRef.current !== SNAPSHOT_UNSET &&
			isEditorSnapshotEqual({
				a: snapshotCacheRef.current,
				b: next,
			})
		) {
			return snapshotCacheRef.current;
		}

		snapshotCacheRef.current = next;
		return next;
	}, [editor, selector]);

	return useSyncExternalStore(
		selector ? subscribeAll : subscribeNone,
		getSnapshot,
		getSnapshot,
	);
}

const PLAYBACK_STORES = [subscribePlayback];
const TIMELINE_STORES = [subscribeTimeline];
const TIMELINE_SCENE_STORES = [subscribeTimeline, subscribeScenes];
const TIMELINE_SELECTION_STORES = [
	subscribeTimeline,
	subscribeScenes,
	subscribeSelection,
];
const PROJECT_STORES = [subscribeProject];
const MEDIA_STORES = [subscribeMedia];
const RENDERER_STORES = [subscribeRenderer];
const SELECTION_STORES = [subscribeSelection];
const DIAGNOSTICS_STORES = [subscribeDiagnostics];
const TRANSCRIPTION_STORES = [subscribeTranscription];

export function useEditorPlayback<T>(selector: (editor: EditorCore) => T): T {
	return useSubscribedEditor({ selector, stores: PLAYBACK_STORES });
}

export function useEditorTimeline<T>(selector: (editor: EditorCore) => T): T {
	return useSubscribedEditor({ selector, stores: TIMELINE_STORES });
}

export function useEditorTimelineScenes<T>(
	selector: (editor: EditorCore) => T,
): T {
	return useSubscribedEditor({ selector, stores: TIMELINE_SCENE_STORES });
}

export function useEditorTimelineSelection<T>(
	selector: (editor: EditorCore) => T,
): T {
	return useSubscribedEditor({ selector, stores: TIMELINE_SELECTION_STORES });
}

export function useEditorProject<T>(selector: (editor: EditorCore) => T): T {
	return useSubscribedEditor({ selector, stores: PROJECT_STORES });
}

export function useEditorMedia<T>(selector: (editor: EditorCore) => T): T {
	return useSubscribedEditor({ selector, stores: MEDIA_STORES });
}

export function useEditorMediaAsset({
	mediaId,
}: {
	mediaId: string | null | undefined;
}): MediaAsset | null {
	const selector = useCallback(
		(editor: EditorCore) => {
			if (!mediaId) {
				return null;
			}
			return (
				editor.media.getAssets().find((asset) => asset.id === mediaId) ?? null
			);
		},
		[mediaId],
	);
	return useEditorMedia(selector);
}

export function useEditorRenderer<T>(selector: (editor: EditorCore) => T): T {
	return useSubscribedEditor({ selector, stores: RENDERER_STORES });
}

export function useEditorSelection<T>(selector: (editor: EditorCore) => T): T {
	return useSubscribedEditor({ selector, stores: SELECTION_STORES });
}

export function useEditorDiagnostics<T>(
	selector: (editor: EditorCore) => T,
): T {
	return useSubscribedEditor({ selector, stores: DIAGNOSTICS_STORES });
}

export function useEditorTranscription<T>(
	selector: (editor: EditorCore) => T,
): T {
	return useSubscribedEditor({ selector, stores: TRANSCRIPTION_STORES });
}
