#!/usr/bin/env python3
"""Read-only source-to-output budget guard; does not assess meaning or edit media."""
import json
import math
import sys
from pathlib import Path


def number(value, label, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum:
        raise ValueError(f"{label} must be finite and >= {minimum}")
    return float(value)


def check(plan):
    target = number(plan["targetSeconds"], "targetSeconds", 0.001)
    cta = number(plan.get("ctaSeconds", 0), "ctaSeconds")
    tolerance = number(plan.get("toleranceSeconds", 0.25), "toleranceSeconds")
    source = plan["protectedSceneId"]
    destination = plan["outputSceneId"]
    if not isinstance(source, str) or not source.strip() or not isinstance(destination, str) or not destination.strip() or source == destination:
        raise ValueError("An explicit output scene must differ from the protected source scene")
    clips = plan["clips"]
    if not isinstance(clips, list) or not clips:
        raise ValueError("clips must be a nonempty array")
    occupied = set()
    speech = 0.0
    gaps = 0.0
    durations = []
    effective_durations = []
    previous = None
    for clip in clips:
        identity = clip["id"]
        if not isinstance(identity, str) or not identity or identity in occupied:
            raise ValueError("Clip IDs must be nonempty and unique")
        occupied.add(identity)
        start = number(clip["sourceIn"], f"{identity}.sourceIn")
        end = number(clip["sourceOut"], f"{identity}.sourceOut")
        if end <= start:
            raise ValueError(f"{identity}: sourceOut must exceed sourceIn")
        if "sourceDurationSeconds" in clip and end > number(clip["sourceDurationSeconds"], f"{identity}.sourceDurationSeconds"):
            raise ValueError(f"{identity}: range exceeds the source duration")
        rate = number(clip.get("playbackRate", 1), f"{identity}.playbackRate", 0.001)
        if clip.get("overlapWithPreviousSeconds", 0) != 0:
            raise ValueError("Overlapping dialogue requires an explicit mixed-timeline plan; this checker only sums serial passages")
        duration = (end-start)/rate
        gap = number(clip.get("gapBeforeSeconds", 0), f"{identity}.gapBeforeSeconds")
        durations.append(duration)
        source_key = clip.get("sourceSceneId", source)
        adjacent = previous is not None and previous[0] == source_key and math.isclose(previous[1], start, abs_tol=0.05) and gap == 0
        if adjacent:
            effective_durations[-1] += duration
        else:
            effective_durations.append(duration)
        previous = (source_key, end)
        speech += duration
        gaps += gap
    total = speech+gaps+cta
    warnings = []
    if len(clips) < 6 and plan.get("mode", "montage") == "montage":
        warnings.append("Few source units for a requested dense montage; review narrative progression")
    if len(effective_durations) < 2 and plan.get("mode", "montage") == "montage":
        warnings.append("Units collapse to one continuous source passage; review whether this satisfies the requested montage")
    if max(effective_durations) > target*0.35:
        warnings.append("One passage occupies >35% of the total target; review whether it is an intentional anchor")
    if cta == 0:
        warnings.append("No closing time reserved; confirm the desired ending")
    if abs(total-target) > tolerance:
        raise ValueError(f"Planned duration {total:.3f}s differs from target {target:.3f}s by {total-target:+.3f}s (tolerance {tolerance:.3f}s)")
    return {"valid": True, "sourceUnits": len(clips), "effectiveSourcePassages": len(effective_durations), "speechSeconds": round(speech,6), "gapsSeconds": round(gaps,6), "ctaSeconds": cta, "totalSeconds": round(total,6), "targetSeconds": target, "warnings": warnings, "limit": "Timing and scene-ID checks only; not word alignment, semantic fidelity or actual render validation"}


def main():
    try:
        if len(sys.argv) != 2:
            raise ValueError("Usage: check_edit_plan.py PLAN.json")
        result = check(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (KeyError, ValueError, TypeError, OSError) as error:
        print(json.dumps({"valid": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
