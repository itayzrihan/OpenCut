import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
let running = false,
	reason: string | null = null;
let item: any = {
	id: "unified",
	name: "Interview",
	type: "video",
	unifiedAngles: { version: 1 },
};
const editor: any = {
	media: {
		getAssets: () => [item],
		isUnifiedAnglesSyncing: () => running,
		syncUnifiedAngles: () => {},
	},
	project: {
		getActiveOrNull: () => ({ metadata: { id: "project" } }),
		getSessionReadOnlyReason: () => reason,
	},
};
mock.module("@/editor/use-editor", () => ({
	useEditor: () => editor,
	useEditorMedia: (f: any) => f(editor),
	useEditorProject: (f: any) => f(editor),
}));
mock.module("@/media/unified-angles", () => ({
	unifiedAnglesSyncStatus: ({ asset }: any) =>
		asset.unifiedAngles.sync ? "synced" : "unsynced",
}));
const { UnifiedAnglesSyncBadge } = await import("./unified-angles-sync-badge");
const { DraggableItem } = await import("../draggable-item");
function html(task: any, active = false) {
	item = { ...item, unifiedAngles: { version: 1, syncTask: task } };
	running = active;
	reason = null;
	return renderToStaticMarkup(<UnifiedAnglesSyncBadge item={item} />);
}
test("in-flight synchronization exposes disabled busy action, animated indicator and accessible progress", () => {
	const s = html(
		{
			id: "run",
			status: "running",
			progress: 0.6,
			stage: "Reading camera audio",
		},
		true,
	);
	expect(s).toContain("Syncing audio 60%");
	expect(s).toContain("animate-spin");
	expect(s).toContain('role="progressbar"');
	expect(s).toContain('aria-valuenow="60"');
	expect(s).toContain('aria-busy="true"');
	expect(s).toContain('disabled=""');
});
test("an orphaned running job is an interrupted retry action rather than an endless spinner", () => {
	const s = html({ id: "orphan", status: "running", progress: 0.6 });
	expect(s).toContain("Sync interrupted · Retry");
	expect(s).toContain("Retry audio sync for Interview");
	expect(s).not.toContain('disabled=""');
	expect(s).not.toContain("animate-spin");
});
test("failed and legacy unsynchronized media expose a retry/start action and reason", () => {
	expect(
		html({
			id: "failed",
			status: "failed",
			progress: 0.3,
			error: "No shared camera sound",
		}),
	).toContain('title="No shared camera sound"');
	expect(html(undefined)).toContain("Sync audio for Interview");
	expect(html(undefined)).toContain("Not audio synced");
});
test("synced metadata shows success; a read-only project cannot launch workers", () => {
	item = { ...item, unifiedAngles: { version: 1, sync: { method: "audio" } } };
	expect(
		renderToStaticMarkup(<UnifiedAnglesSyncBadge item={item} />),
	).toContain("Audio synced");
	html(undefined);
	reason = "Take ownership first";
	const s = renderToStaticMarkup(<UnifiedAnglesSyncBadge item={item} />);
	expect(s).toContain('disabled=""');
	expect(s).toContain("Take ownership first");
});
test("compact media keeps the retry button outside the draggable button", () => {
	html(undefined);
	const s = renderToStaticMarkup(
		<DraggableItem
			name="Interview"
			preview={<span>Camera</span>}
			variant="compact"
			dragData={{
				id: "unified",
				type: "media",
				mediaType: "video",
				name: "Interview",
			}}
			labelExtra={<UnifiedAnglesSyncBadge item={item} />}
		/>,
	);
	expect(s).toContain("Sync audio for Interview");
	expect(s).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
});
