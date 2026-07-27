/**
 * Function names accepted at the server boundary after client tool names are
 * converted from dotted editor names (`timeline.get_layer`) to wire names
 * (`timeline_get_layer`). Keep this module data-only so API routes do not pull
 * editor/runtime dependencies into the server bundle.
 */
export const ALLOWED_AI_TOOL_WIRE_NAMES: ReadonlySet<string> = new Set([
	"app_get_state",
	"bookmarks_list",
	"captions_get_source",
	"capabilities_search",
	"catalog_get",
	"catalog_list",
	"catalog_search",
	"export_cancel",
	"export_get_status",
	"library_search",
	"playback_control",
	"preview_capture_frame",
	"preview_capture_range_frames",
	"scene_activate",
	"skills_list",
	"skills_load",
	"timeline_edit_source",
	"timeline_edit_full_source",
	"timeline_get_element",
	"timeline_get_layer",
	"timeline_get_visible_state",
	"timeline_inspect_range",
	"timeline_list_media",
	"timeline_propose_edit_plan",
	"timeline_read_full_source",
	"timeline_read_source",
	"timeline_search_elements",
	"timeline_search_layers",
	"timeline_stage_operations",
	"transcription_cancel",
	"transcription_get_status",
]);

export function isAllowedAiToolWireName({ name }: { name: string }): boolean {
	return ALLOWED_AI_TOOL_WIRE_NAMES.has(name);
}
