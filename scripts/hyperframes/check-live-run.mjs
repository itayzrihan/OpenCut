// Verify a real editor run's saved receipts beside independently decoded bytes.
// Credentials and provider reasoning/context are never included in the report.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const [recordPath, videoPath, outputPath, profile = "baseline", delivery = "supplied-file"] = process.argv.slice(2);
if (!recordPath || !videoPath || !outputPath) throw new Error("Usage: node check-live-run.mjs <project.json> <video|--host-only> <evidence-directory> [baseline|correction] [supplied-file|browser-download|artifact-store]");
assert.ok(["baseline", "correction"].includes(profile));
assert.ok(["supplied-file", "browser-download", "artifact-store"].includes(delivery));
const project = JSON.parse(await fs.readFile(recordPath, "utf8"));
const session = JSON.parse(project.__opencutEditorSession);
const checkpoint = JSON.parse(session.saved.bundle.agentCheckpoint);
const archive = typeof session.saved.bundle.archive === "string" ? JSON.parse(session.saved.bundle.archive) : session.saved.bundle.archive;
const composition = Object.values(archive.classic.document.hyperframesCompositions).find((item) => item.compositionId === "lt-clean-bar");
assert.ok(composition, "Expected the remixed reference in the saved project");
const source = archive.sources[composition.source];
const original = Object.values(archive.sources).find((item) => item.files[item.entryFile]?.includes("Dr. Maya Chen"));
assert.ok(original, "The original imported source must remain available in undo history");
const expectedSource = structuredClone(original);
expectedSource.files[expectedSource.entryFile] = expectedSource.files[expectedSource.entryFile]
    .replace("Dr. Maya Chen", "OpenCut Studio")
    .replace("Host · Neuroscientist", "From idea to edit")
    .replace("#ff5a36", "#7c3aed");
if (profile === "baseline") {
    assert.deepEqual(source, expectedSource, "Only the three requested source substitutions may change; animation must remain intact");
} else {
    const title = "OpenCut Studio — From idea to a finished video";
    assert.ok(source.files[source.entryFile].includes(title));
    assert.ok(source.files[source.entryFile].includes("Autonomous video editing"));
    assert.ok(source.files[source.entryFile].includes("#7c3aed"));
    const draft = Object.values(archive.sources).find((item) => item.files[item.entryFile]?.includes(title) && /font-size:\s*180px/.test(item.files[item.entryFile]));
    assert.ok(draft, "The oversized first Remix must remain available in undo history");
    assert.notDeepEqual(source, draft, "The second Remix must actually correct the draft");
    const scripts = (html) => html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi);
    assert.deepEqual(scripts(source.files[source.entryFile]), scripts(original.files[original.entryFile]), "Animation scripts must remain unchanged");
    for (const [name, content] of Object.entries(original.files)) if (name !== original.entryFile) assert.equal(source.files[name], content);
}
const run = checkpoint.run;
assert.equal(run.phase, "completed", "The actual agent run must complete");
assert.equal(run.steering.length, 0, "This acceptance must run without follow-up steering");
assert.ok(run.plan.length > 0 && run.plan.every((step) => step.status === "complete"), "Every planned stage must be complete");
const receipts = run.receipts;
const required = profile === "baseline"
    ? ["hyperframes.examples.import", "editor.preview.render", "hyperframes.composition.remix", "editor.preview.render", "editor.export.render"]
    : ["hyperframes.examples.import", "hyperframes.composition.remix", "editor.preview.render", "hyperframes.composition.remix", "editor.preview.render", "editor.export.render"];
let previous = -1;
for (const capability of required) {
    const index = receipts.findIndex((r, i) => i > previous && r.capabilityId === capability && r.committed);
    assert.ok(index > previous, `Missing successful ordered stage: ${capability}`);
    previous = index;
}
const remixes = receipts.filter((r) => r.capabilityId === "hyperframes.composition.remix" && r.committed);
const reviewPrefix = "Host render review (sampled evidence, not full video QA): ";
const renderReviews = checkpoint.provider.groups.filter((group) => group.id.startsWith("review-")).flatMap((group) => group.items
    .filter((item) => typeof item.content === "string" && item.content.startsWith(reviewPrefix))
    .map((item) => JSON.parse(item.content.slice(reviewPrefix.length))));
if (profile === "correction") {
    assert.ok(renderReviews.some((review) => review.revision === remixes[0].revision && review.review.issues.length > 0), "Rendered review must identify a defect in the first Remix");
    assert.ok(renderReviews.some((review) => review.revision >= remixes.at(-1).revision && review.review.issues.length === 0), "Rendered review must accept the corrected revision");
}
const finalExport = receipts.findLast((r) => r.capabilityId === "editor.export.render" && r.committed);
assert.equal(finalExport.revision, run.revision, "Export must match final document revision");
assert.ok(checkpoint.provider.responses.length > 0, "Provider rounds must be recorded");
const exportResult = checkpoint.provider.groups.flatMap((g) => g.items)
    .filter((item) => item.type === "function_call_output" && item.call_id === finalExport.callId)
    .map((item) => JSON.parse(item.output))
    .find((item) => item.ok)?.result?.result?.data;
assert.equal(exportResult?.artifact?.mimeType, "video/webm");
assert.equal(exportResult?.media?.audioTracks, 0);
assert.equal(exportResult?.media?.packetCount, 48);
assert.equal(exportResult?.media?.frameRate, 10);
assert.equal(exportResult?.media?.width, 1920);
assert.equal(exportResult?.media?.height, 1080);
assert.ok(Math.abs(exportResult?.media?.durationSeconds - 4.8) < 0.01);
const directory = path.resolve(outputPath);
await fs.mkdir(directory, { recursive: true });
const baseReport = {
    profile,
    projectId: project.metadata.id,
    runId: run.scope.runId,
    request: run.request,
    finalMessage: run.finalMessage,
    providerRounds: checkpoint.provider.responses.length,
    followUpSteering: run.steering.length,
    remixPasses: remixes.length,
    sourceVerification: { exactRequestedSubstitutions: profile === "baseline", initialOversizedDraftPreserved: profile === "correction", originalAnimationPreserved: true },
    renderReviews,
    receipts: receipts.map(({ capabilityId, revision, committed, artifactIds }) => ({ capabilityId, revision, committed, artifactIds })),
};
if (videoPath === "--host-only") {
    const report = {
        scope: "savedAgentRunAndHostContainerInspection",
        status: "liveRunCompleted_externalFileVerificationPending",
        ...baseReport,
        export: { artifact: exportResult.artifact, hostInspection: exportResult.media, downloadedBytesVerified: false, fullExternalDecodePassed: false },
        limitations: ["No downloaded file was supplied: this mode does not certify download behavior or independent decoding", "Browser playback observations must be recorded separately", "No packaged Electron or deployed HTTPS SaaS acceptance"],
    };
    await fs.writeFile(path.join(directory, "host-report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ status: report.status, directory, providerRounds: report.providerRounds }));
    process.exit(0);
}
const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", videoPath], { encoding: "utf8", windowsHide: true }));
const video = probe.streams.find((s) => s.codec_type === "video");
assert.ok(video && Number(probe.format.duration) > 0, "Export must decode as a video");
const bytes = await fs.readFile(videoPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(exportResult?.artifact?.sha256, sha256, "Supplied bytes must match the actual export receipt");
assert.equal(exportResult?.artifact?.mimeType, "video/webm");
assert.ok(probe.format.format_name.split(",").includes("webm"), "Expected a WebM container");
assert.equal(exportResult?.media?.audioTracks, 0, "This acceptance requests a silent video");
assert.equal(probe.streams.filter((stream) => stream.codec_type === "audio").length, 0);
const [frameNumerator, frameDenominator = "1"] = video.avg_frame_rate.split("/");
assert.ok(Math.abs(Number(frameNumerator) / Number(frameDenominator) - 10) < 0.01, "Expected 10fps acceptance output");
assert.equal(video.width, 1920);
assert.equal(video.height, 1080);
assert.ok(Math.abs(Number(probe.format.duration) - 4.8) < 0.11, "Expected 4.8-second acceptance output");
execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", videoPath, "-f", "null", "-"], { windowsHide: true });
const name = "result.webm";
await fs.writeFile(path.join(directory, name), bytes);
const times = [0.8, Number(probe.format.duration) / 2, Math.max(0.1, Number(probe.format.duration) - 0.8)];
for (const [index, time] of times.entries()) execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(time), "-i", videoPath, "-frames:v", "1", "-vf", "scale=960:-1", path.join(directory, `frame-${index}.png`)], { windowsHide: true });
const report = {
    scope: "savedAgentRunAndDecodedExport",
    status: "passed",
    ...baseReport,
    export: { file: name, bytes: bytes.length, sha256, inputProvenance: delivery, browserDownloadVerified: delivery === "browser-download", matchesHostReceipt: true, fullDecodePassed: true, hostInspection: exportResult.media, codec: video.codec_name, width: video.width, height: video.height, durationSeconds: Number(probe.format.duration), frameRate: video.avg_frame_rate },
    sampledFrames: times.map((timeSeconds, index) => ({ timeSeconds, file: `frame-${index}.png` })),
    limitations: [...(delivery === "browser-download" ? [] : ["Browser download behavior was not verified; the supplied file only certifies bytes and independent decoding"]), "Receipt validation does not by itself prove which provider served a request; live transport is observed separately in the app", "Three decoded frames are not exhaustive motion or audio QA", "This local acceptance does not certify packaged Electron or deployed HTTPS SaaS"],
};
await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status: report.status, directory, providerRounds: report.providerRounds, remixPasses: report.remixPasses, export: report.export }));
