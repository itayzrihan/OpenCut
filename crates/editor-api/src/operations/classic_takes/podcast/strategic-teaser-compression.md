---
name: strategic-teaser-compression
description: Select and assemble the strongest moments from a long interview, podcast or recording into a short multi-passage teaser with question-answer structure, escalating stakes and a deliberate withheld payoff. Use for strategic condensation and teaser montages, including Hebrew footage. Do not turn a requested single chronological excerpt into a montage.
---

# בחירת קטעים מעניינים ביותר ודחיסה אסטרטגית שלהם

Produce a short narrative from multiple source moments. The delivered edit must make sense in audio alone, preserve the meaning of the source and give the viewer a reason to watch the full piece. A single long plausible excerpt does not satisfy a request for a dense teaser montage.

Read [the reference analysis](references/content-compression-analysis.he.md) when planning a new teaser or diagnosing a dull selection. It separates observed teaser timing from unknown full-episode source edits. Transfer its mechanisms, not its claims, metrics, personalities or palette.

## Decide the editorial target

Infer audience, desired duration and montage intent from the request and existing project. A 60-second teaser means the complete output, including CTA, breaths, pauses and transitions. Reserve a small explicit closing budget before selecting speech. If the user asks for a chronological short or one complete answer, retain that intent rather than forcing this montage pattern.

## Build a global source inventory

Inspect the full available transcript, with representative footage/audio context across the whole recording. Reuse an existing reliable word-timed transcript. ASR segments are not edit boundaries, and token timestamps are not automatically verified word alignment. Never fabricate word times by dividing subtitle durations.

For each candidate, retain source project/scene, actual in/out times or canonical word IDs, speaker, literal wording, necessary context on both sides, the actual question it answers, and its gross duration including speech-safe handles. Tag its function: hook, proof, contrast, question, consequence, analogy, bridge or open payoff. Distinguish source observations from a proposed editorial order.

Look beyond the opening minutes. Compare candidates from different parts before selecting the opener. Reject candidates whose pronouns, missing objects or removed qualifications require too much new context. Preserve negations, conditions, units, names and material qualifiers such as “בעיניי”.

## Select a chain, not a list of impressive sentences

Use a working premise describing the desired viewer progression, for example: capability → concrete result → objection → consequence → personal stakes → unresolved practical answer. Adapt it to the actual material.

Score candidates informally for stopping power, specificity, tension, standalone clarity and contribution to the chain; penalize context cost and duplication. Score is a decision aid, not proof that a quote is truthful or effective. Optimize marginal contribution per second and compatibility with adjacent units, rather than taking the highest isolated scores.

Keep real Q&A pairs intact. Rearranging thematic passages is allowed when requested, but do not present an answer to one question as the actual response to another, manufacture agreement or remove a qualifier that changes the claim. Preserve deliberate challenge-and-confirmation repetitions; remove repetitions that add no new function.

Pay off some curiosity with a specific result or intelligible principle. Withhold the central explanation only after delivering enough value to earn the next question. End at a complete word/clause or a clearly purposeful start of the next answer. Do not create an unintelligible dangling sentence just to force a cliffhanger.

## Plan the complete time budget

For a requested dense 60-second montage, start by evaluating roughly 8–12 short speech units. This is a planning range, not a quality quota. A 1–5 second unit may carry a question, result or reaction; a longer anchor needs a clear reason and ongoing development. Reject a 40–55 second continuous selection dressed with a short ending unless the user actually wanted that kind of excerpt.

Create a source-to-output ledger before visual production: candidate ID, source in/out, output in/out, speaker, role, retained wording, omitted context, next-beat reason and open question. Include handles in selected ranges and closing time in the total. Do not count visual changes as additional source excerpts, or inflate passage count by splitting one continuous monologue into adjacent tiny ranges. Review the checker's effective-source-passage warning as well as its unit count.

Use [the ledger example](references/edit-plan-example.json) and `scripts/check_edit_plan.py PATH` to catch timing and source-scene mistakes. The example is synthetic, not the reference video's missing hour-long source. The checker verifies arithmetic/structure only; semantic fidelity, actual speech boundaries and the encoded output still need review.

If a host capability has a passage limit, fit the plan to the actual contract. OpenCut's Classic teaser extraction currently allows up to 12 parts in one alternative. Read live discovery/contracts before invoking it; a skill is not authority to bypass a changed constraint. Do not solve excess length by trimming syllables or speeding all speech automatically.

## Apply without consuming the source

For OpenCut/POCUT, use the current canonical editor runtime and native extraction capabilities. Bind project, source scene and revision explicitly, review/dry-run where supported, and create a new editable Sequence. Keep Main, complete transcript, source captions and earlier extracts intact. Reuse existing transcription and durable completed analysis rather than restarting from zero.

Apply finishing edits and caption reflow to the output scene only. A second run adds another sequence from the intact source. On interruption, resume saved preparation where valid; check source/account/revision before applying. Report applied, saved and exported states separately. Do not mutate the live source to demonstrate a skill or change an app algorithm when only analysis was requested.

## Review the selection

Check the edit in audio alone: subject is clear immediately; each unit changes information or stakes; question-answer relationships are honest; numbers and qualifications survive; no cut clips a word; the ending creates a supported reason to continue. Then check the final output duration, source-to-output ledger and original-scene/caption preservation.

A failed chain should be reselected before adding energetic graphics. Use the companion visual editing skill after the narrative is stable, or when a visual beat is needed to convey a valid retained idea. Report unavailable source footage or alignment checks as concrete limits on the affected claims.
