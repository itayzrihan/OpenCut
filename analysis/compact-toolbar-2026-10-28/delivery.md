# Compact editor controls

Classic UI-only layout refinement. Existing canonical Start/End actions, keybindings and scene switching remain unchanged. The timeline now has one36px icon dropdown with Start and End entries and no visible key badges. The existing ScenesView sheet opens from a single active-scene button centered in the desktop header; long names truncate with full title on hover. Below1024px the selector occupies a centered second header row to avoid collisions with project and export controls.

Validated with the production TypeScript config and optimized build. Live UI checks use isolated project b54fef34-bf27-456c-8d4e-a27328a8117d, a generated12s fixture and a long-name test scene. The configuredcheck compares actual DOM bounds and Timeline Source snapshots for menu actions, keyboard equivalence and exact Undo restoration. User podcast projects were not edited.

Activated local release:2026-10-28T03-23-16-249Z-8d720461.
