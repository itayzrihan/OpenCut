# Episode 4 intro fade repair

The saved episode had 179 matching camera pairs with identical durations and complementary enabled states. Every Lior segment was 39.8 seconds later than its Niva counterpart. At 7.326667 seconds Niva switched off, while the corresponding Lior shot did not begin until 47.126667 seconds. The correctly fading intro therefore revealed the black project background.

Using the live canonical `timeline.edit_full_source` transaction, moved only the 179 Lior segment start times back by 4776000 ticks (39.8 seconds). Source trims, durations, enable states, audio tracks, intro opacity/blur keyframes, other scenes and project settings were preserved. No renderer change or export was needed.

Verified saved project against the pre-edit snapshot: exact scene equality except those start times; matching camera pairs; exactly one active camera on every output frame across the intro overlap. Visually checked 6.8,7.8 and 8.133333 seconds in Chrome and played from 5.5 through 16.9 seconds. At 7.8 seconds the former dark frame now shows Lior beneath the nearly transparent intro; at 8.133333 seconds the intro is almost completely gone.

This repair does not change Delete to the same point behavior. Its per-track range handling is a possible source of the displacement, but the exact preceding user action was not established from evidence in this turn.

Verification: `python3 analysis/episode4-intro-fade-2026-10-19/verify.py`. Requires the local pre-edit snapshot and saved project; deliberately not a portable unit test.
