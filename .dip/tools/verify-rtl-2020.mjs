import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

function run(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  if (r.stdout.trim()) console.log(r.stdout.trim());
  return r;
}
run('cargo', ['test', '-q', '-p', 'timeline', 'text_direction']);
run('cargo', ['test', '-q', '-p', 'opencut-editor-api', '--test', 'classic_scenes', '--test', 'classic_takes', '--test', 'classic_update']);
run('node', ['classic/scripts/test-web.mjs',
  'src/text/__tests__/measure-element.test.ts',
  'src/text/__tests__/bottom-fade-out.test.ts',
  'src/text/__tests__/responsive-wrap.test.ts',
  'src/subtitles/__tests__/canonical-caption-text.test.ts',
  'src/ai/__tests__/full-auto-edit-routed.test.ts',
  'src/ai/__tests__/full-auto-edit-resume.test.ts',
  'src/ai/__tests__/music-duration-real.test.ts',
  'src/batch/server.test.ts', 'src/batch/scene-checkpoint.test.ts',
  'src/core/__tests__/canonical-scene-automation.test.ts',
  '--report=.local/rtl-2020-2026-10-24/configured-tests']);
run('node', ['classic/node_modules/typescript/bin/tsc', '--noEmit', '-p', 'classic/apps/web/tsconfig.build.json']);
run('git', ['diff', '--check']);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const e = await json('analysis/rtl-2020-2026-10-24/verification.json');
assert(e.previewQuestionReviewed && e.exportQuestionReviewed && e.editorReloaded && e.rtlEditorVerified);
const before = await json('.local/rtl-2020-2026-10-24/project-before.json');
const after = await json(join(homedir(), 'Movies/OpenCut Accounts/data', e.accountId, 'projects', e.projectId, 'project.json'));
assert.deepEqual(after.scenes, before.scenes);
assert.deepEqual(after.settings, before.settings);
assert.equal(after.automationEdits.filter(j => j.status === 'published').length, 3);
assert((await stat(e.exportPath)).size > 500000);
const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', e.exportPath]).stdout);
const video = probe.streams.find(s => s.codec_type === 'video');
assert(video && video.width === e.exportDimensions.width && video.height === e.exportDimensions.height);
assert.equal(video.avg_frame_rate, '25/1');
assert(probe.streams.some(s => s.codec_type === 'audio'));
assert(Math.abs(Number(probe.format.duration) - 42.73) < 0.12);
run('ffmpeg', ['-v', 'error', '-i', e.exportPath, '-f', 'null', '-']);
const volume = run('ffmpeg', ['-hide_banner', '-i', e.exportPath, '-vn', '-af', 'volumedetect', '-f', 'null', '-']).stderr.match(/mean_volume: (-?[\d.]+) dB/);
assert(volume && Number(volume[1]) > -60, 'Export must contain audible audio');
const release = await json(join(homedir(), 'Library/Application Support/OpenCut Local/current.json'));
assert.equal(release.id, e.release);
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 ** 2 }).toString().split('\0').filter(Boolean).sort();
const hash = createHash('sha256');
for (const file of files) {
  if (file.endsWith('/next-env.d.ts')) continue;
  if (!/^(classic\/(apps\/(web|electron\/app)|rust|packages|patches)\/|crates\/|resources\/|Cargo\.(toml|lock)$|classic\/(package\.json|bun\.lock)$)/.test(file)) continue;
  hash.update(file);
  try { hash.update(await readFile(file)); } catch (error) { if (error.code === 'ENOENT') hash.update('deleted'); else throw error; }
}
assert.equal(hash.digest('hex'), release.fingerprint);
assert((await fetch('http://localhost:3211/projects')).ok);
console.log(JSON.stringify({ preservedScenes: before.scenes.length, tests: 95, audioMeanDb: Number(volume[1]), exportPath: e.exportPath, release: release.id }));
