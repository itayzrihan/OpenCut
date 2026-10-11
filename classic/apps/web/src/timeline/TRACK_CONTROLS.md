# Track controls layout

Status: bridged Classic UI capability. The rewrite does not duplicate this UI.
`ClassicProject.document.settings.timelineTrackControlsWidth` is optional (112 px
when absent). The existing typed `project.classic.settings.update` registry action
accepts integer widths 80..480, validates generic document loads/patches too, and
provides revision checks, dry runs, idempotency and Undo/Redo. Registry tests read
it back through `app.state.read` and verify unrelated timeline content is preserved.

The separator previews pointer geometry in the host, committing one canonical
settings edit when released. Pointer cancellation discards the preview; keyboard
arrows adjust by 16 pixels, Home/End use the limits, double-click restores 112.
The size persists with the project. Snap indicators use this same live width.

A horizontal scroll viewport keeps the full control row reachable in a narrow
column. Header arrows, its scrollbar, horizontal trackpad input and Shift+wheel
scroll the controls independently of timeline time. Vertical scrolling continues
to synchronize labels and clips. The minimum inner width accommodates the largest
current control group; all controls fit at 240 pixels or wider.
