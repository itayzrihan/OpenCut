"""Reproduce the source comparison from fetched, pinned Git refs (no checkout changes).
Run from any directory: python3 classic/apps/hypercut/audit/build_report.py
This is a source audit, not a runtime feature-parity test.
"""
import csv
import html
import hashlib
import json
import re
import subprocess
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def tree(ref):
    return set(git("ls-tree", "-r", "--name-only", ref).splitlines())


refs = {
    "oursMain": "origin/main",
    "oursEditorBranch": "origin/מיזוג-עם-העורך-של-Hyper-frames",
    "officialRewrite": "upstream/main",
    "officialClassic": "official-classic/main",
    "localHypercut": "HEAD",
}
repos = {
    "oursMain": "itayzrihan/OpenCut",
    "oursEditorBranch": "itayzrihan/OpenCut",
    "officialRewrite": "OpenCut-app/OpenCut",
    "officialClassic": "OpenCut-app/opencut-classic",
    "localHypercut": "itayzrihan/OpenCut",
}
snapshots = {
    key: dict(ref=ref, sha=git("rev-parse", ref), repository=repos[key],
              commitDate=git("show", "-s", "--format=%cI", ref),
              subject=git("show", "-s", "--format=%s", ref))
    for key, ref in refs.items()
}
trees = {key: tree(v["sha"]) for key, v in snapshots.items()}
main, branch, classic, upstream = [snapshots[k]["sha"] for k in
                                  ("oursMain", "oursEditorBranch", "officialClassic", "officialRewrite")]


def source(path):
    path = path[1:] if path.startswith("@") else "classic/apps/web/src/" + path
    key = "oursMain" if path in trees["oursMain"] else "oursEditorBranch"
    if path in trees["oursMain"] and path in trees["oursEditorBranch"]:
        if git("rev-parse", f"{main}:{path}") != git("rev-parse", f"{branch}:{path}"):
            key = "oursEditorBranch"
    assert path in trees[key], f"Not present in fetched remote: {path}"
    sha = snapshots[key]["sha"]
    is_classic = path.startswith("classic/")
    baseline_key = "officialClassic" if is_classic else "officialRewrite"
    baseline_path = path.removeprefix("classic/") if is_classic else path
    baseline = snapshots[baseline_key]["sha"]
    blob = git("rev-parse", f"{sha}:{path}")
    exists = baseline_path in trees[baseline_key]
    baseline_blob = git("rev-parse", f"{baseline}:{baseline_path}") if exists else None
    content = git("show", f"{sha}:{path}")
    anchors = [(i + 1, line.strip()[:180]) for i, line in enumerate(content.splitlines())
               if re.search(r"^(export (async )?(function|class|const|interface)|pub (async )?fn)", line)]
    line = anchors[0][0] if anchors else 1
    return dict(path=path, remote=key, commit=sha, blob=blob,
                baseline=baseline_key, baselinePath=baseline_path, baselineBlob=baseline_blob,
                delta="added" if not exists else "unchanged" if blob == baseline_blob else "modified",
                url=f"https://github.com/{repos[key]}/blob/{sha}/{path}#L{line}",
                baselineUrl=f"https://github.com/{repos[baseline_key]}/blob/{baseline}/{baseline_path}" if exists else None,
                declarations=[dict(line=i, text=t) for i, t in anchors[:6]])


strategies = {
    "rust-adapter": "לשמר את האלגוריתם/המדיניות ב-Rust ולהוסיף מתאם למסמך ולפעולות של Studio; לא להפעיל פקודות Classic על עותק timeline נפרד.",
    "render-adapter": "לשמר פרמטרים ותוצאה חזותית; לממש ב-HTML/GSAP/שכבות של HF ולבדוק seek וייצוא, בלי להעתיק את renderer הישן.",
    "asset-adapter": "להעביר הגדרות, מזהי נכסים, רישוי ותלויות; להתאים את כפתורי ההחלה והפרמטרים ל-Studio ולשמירה הקנונית.",
    "host-adapter": "לחבר שירות/עבודת רקע/מערכת הפעלה ל-host של HyperCut, עם בידוד חשבונות, ביטול, recovery ויכולות runtime לפי הצורך.",
    "native-verify": "להשתמש במנגנון המקורי של HF, להשוות את ההתנהגות הנדרשת בפועל ולהוסיף רק את הפער; עצם קיום UI דומה אינו הוכחת תאימות.",
}
features = []
for n, row in enumerate(csv.DictReader((HERE / "requirements.tsv").open(), delimiter="\t"), 1):
    evidence = [source(p) for p in row.pop("sources").split(";")]
    assert any(e["delta"] != "unchanged" for e in evidence), f"No changed evidence: {row['id']}"
    row.update(number=n, priority=int(row["priority"]), evidence=evidence,
               implementationStrategy=strategies[row["strategy"]],
               hypercutStatus="custom-workflow-not-connected",
               confidence="source-confirmed; end-to-end acceptance not rerun")
    if row["strategy"] == "native-verify":
        row["hypercutStatus"] = "native-analogue-needs-behavior-validation"
    if row["id"] in ("canonical-mcp", "project-ownership", "hf-authoring"):
        row["hypercutStatus"] = "partial-foundation; complete-workflow-pending"
    features.append(row)

tab_path = "apps/web/src/components/editor/panels/assets/assets-panel-store.tsx"
def tabs(text):
    return re.findall(r'"([a-z-]+)"', re.search(r"TAB_KEYS = \[(.*?)\]", text, re.S)[1])
old_tabs = tabs(git("show", f"{classic}:{tab_path}"))
our_tabs = tabs(git("show", f"{main}:classic/{tab_path}"))
diff = git("diff", "--name-status", "--no-renames", classic, f"{main}:classic")
file_changes = [dict(status=line.split("\t")[0], path=line.split("\t")[-1]) for line in diff.splitlines()]
presets = []
for path in ["text/caption-presets.ts", "effects/overlay-presets.ts", "effects/overlay-movement-presets.ts",
             "loops/registry.ts", "ui-elements/catalog.ts", "backgrounds/presets.ts", "simple-advanced-layers/catalog.ts"]:
    evidence = source(path)
    content = git("show", f"{evidence['commit']}:{evidence['path']}")
    literals = list(dict.fromkeys(re.findall(r'\bid:\s*"([\w-]+)"', content)))
    presets.append(dict(source=evidence, literalIds=literals,
                        note="Explicit ID literals only; dynamic/composed entries may add IDs. Not a feature count or runtime validation."))

baseline = [
    ("ייבוא מדיה, preview ו-scrub", "מקורי ב-OpenCut וב-HF; ב-HyperCut הבסיס נבדק. אין לספור כפיצ׳ר שפיתחנו מאפס."),
    ("split, trim, move, duplicate, copy/paste ומחיקה", "עריכת NLE בסיסית קיימת במקור; יש לבדוק את הרחבות הדיוק וה-ripple שלנו בנפרד."),
    ("Undo/Redo", "מקורי; אצלנו נוספה היסטוריה קנונית והתמדה. ב-HyperCut מחובר בסיס, grouping מורכב עדיין חסר."),
    ("שכבות, מיקום, scale ו-keyframes", "מקורי; אין להחליף את ממשק HF. תצוגת שמות שכבות קבועה כבר נוספה מקומית."),
    ("טקסט, Whisper וכתוביות בסיסיות", "כבר קיימים ב-Classic הרשמי. התוספות שלנו הן עברית/alignments/Auto Texts/עיצוב ועריכה מתקדמים."),
    ("מסכות, הפרדת אודיו, retime ו-bookmarks", "כבר קיימים במקור; רק ההרחבות והסמנטיקה החדשה נכללות ברשימת הדרישות."),
    ("Catalog של HyperFrames", "446 פריטים הוצגו בבדיקה המקומית; browsing מחובר, התקנה לפרויקט עדיין לא מחוברת."),
    ("Code / Variables / Design של HF", "מסכי מקור קיימים; Timeline Code הסמנטי שלנו אינו זהה לעריכת HTML."),
    ("Export / Render Queue של HF", "יש מסכים מקוריים, אך בשרת HyperCut startRender עדיין לא מחובר ומחזיר כשל מפורש."),
    ("Adjustment", "placeholder ב-Classic הרשמי וגם אצלנו. יש אפקט color-correction, אך אין לטעון שפאנל Adjustment הושלם."),
]
local_commits = git("log", "--format=%H\t%s", f"{branch}..HEAD").splitlines()
hf_evidence = []
for path in ["src/App.tsx", "server/app.ts", "MIGRATION.md", "VERIFICATION.md",
             "node_modules/@hyperframes/studio/src/hooks/useTimelineEditing.ts",
             "node_modules/@hyperframes/studio/src/hooks/useBlockCatalog.ts",
             "node_modules/@hyperframes/studio/src/hooks/useGsapKeyframeOps.ts",
             "node_modules/@hyperframes/studio/src/captions/components/CaptionPropertyPanel.tsx",
             "node_modules/@hyperframes/studio/src/components/renders/useRenderQueue.ts"]:
    file = HERE.parent / path
    assert file.is_file(), path
    hf_evidence.append(dict(path=path, sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
                            installedStudioVersion="0.8.146", scope="local HyperCut/source review, not remote OpenCut evidence"))
performance = [
    dict(title="היסטוריה קומפקטית וטעינת session", provenance="remote editor branch", evidence=[source("core/canonical-classic-session.ts"), source("editor-agent/server/session-store.ts")], requirement="לשמר את היעד: היסטוריה מוגבלת ושחזור בלי כתיבה חוזרת של כל המסמך. לא להעתיק פורמט Classic ל-HF."),
    dict(title="שימוש חוזר ב-decoder/audio sink", provenance="remote editor branch", evidence=[source("media/audio-sink-cache.ts"), source("core/managers/audio-manager.ts")], requirement="לבחון את הכנת האודיו וה-cache ב-HF על מדיה אמיתית; לא להוסיף את צינור הכנת האודיו הישן."),
    dict(title="וירטואליזציה של timeline ונכסים", provenance="remote main", evidence=[source("timeline/components/visible-elements.ts"), source("timeline/components/track-element-index.ts"), source("components/editor/panels/assets/views/assets-virtualization.ts")], requirement="לשמור גלילה/בחירה מהירות בפרויקטים ארוכים; למנף virtualization המקורי של HF."),
    dict(title="Preview proxies, waveform worker והכנת אודיו סביב הסמן", provenance="local-only commits beyond fetched editor remote", evidence=[], requirement="השיפורים האחרונים מקומיים; benchmark זהה של load/first Play/seek/memory/save/export הוא תנאי לשחרור. אין טענת מדידה חדשה ל-HyperCut בדוח זה."),
]
report = dict(
    schemaVersion=1, auditedOn="2026-10-11", snapshots=snapshots,
    scope="Remote main + remote editor-branch additions; current local HyperCut assessed separately. New projects only; no legacy-project conversion.",
    method=["Fetched origin, upstream and official Classic main; pinned the resulting SHAs.",
            "Compared official Classic root against our main:classic tree to avoid counting the directory move as features.",
            "Compared official rewrite with our root crates/apps separately; verified additional remote editor-branch source paths.",
            "Reviewed changed modules, UI wiring, tests and history; source presence does not establish runtime parity.",
            "Validated every cited source path and blob against the fetched remote; no application feature changed by this audit."],
    limits=["90 is a set of migration requirements, including subfeatures/extensions, not 90 independent inventions and not an exhaustive count of every preset/control.",
            "No end-to-end acceptance run for these 90 workflows in this audit. Native analogues require behavior tests.",
            "Git cannot inventory private media, fonts, audio and presets that exist only in local/user storage. A separate asset manifest audit is required before parity sign-off.",
            "Official Classic is archived; comparing only the rewrite would falsely classify almost the entire mature editor as custom.",
            "Historical/internal refs not merged into the chosen remote lines are not claimed as released features. The four named custom origin branches checked are ancestors of origin/main."],
    statistics=dict(classicDiffSummary=git("diff", "--shortstat", classic, f"{main}:classic"),
                    classicFileStatusesNoRename=Counter(x["status"] for x in file_changes),
                    rewriteDivergence=git("rev-list", "--left-right", "--count", f"{main}...{upstream}"),
                    requirements=len(features), origins=Counter(x["origin"] for x in features),
                    priorities=Counter(str(x["priority"]) for x in features)),
    panels=dict(original=old_tabs, ours=our_tabs, added=[t for t in our_tabs if t not in old_tabs],
                note="Panel presence does not imply implemented functionality; see Adjustment and original Transitions placeholder."),
    baseline=[dict(feature=t, assessment=d) for t, d in baseline],
    requirements=features, presetInventories=presets, normalizedClassicFileChanges=file_changes,
    hypercutSourceEvidence=hf_evidence, performanceRequirements=performance,
    localOnlyCommits=[dict(sha=l.split("\t", 1)[0], subject=l.split("\t", 1)[1]) for l in local_commits],
    localOnlyNote="Performance proxies, worker waveforms, playback preparation and new HyperCut host are local commits beyond the fetched editor remote. Timeline-label and catalog changes also include uncommitted files. Do not present these as already on remote.",
    roadmap=[
        "בסיס לשחרור: שמירה/שחזור, ייצוא, קטלוג+התקנה, נכסים/פונטים/SFX, playback ו-revision fencing.",
        "מסלול הדיבור: עברית ותזמון מילים → שקט ושחזור → Smart Takes → Auto Texts → Full Auto ו-resume/batch.",
        "שימור השפה החזותית: ספריות טקסט/מעברים/סאונדים, UI Elements, שכבות חכמות, B-roll ו-Parallax.",
        "השלמת workflows: פודקאסט/מולטיקאם, AI/MCP, חשבונות/מכשירים, גיבוי, Premiere XML ו-Electron.",
        "לכל דרישה: תוצאה חזותית+אודיו, עריכה, Undo/Redo, שמירה/פתיחה, ייצוא ובנצ׳מרק על אותו חומר. עד אז אין טענת parity מלאה."])
(HERE / "comparison.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

esc = html.escape
status = {
    "custom-workflow-not-connected": "לא מחובר ל-HyperCut",
    "native-analogue-needs-behavior-validation": "קיים מנגנון דומה; נדרשת בדיקת התנהגות",
    "partial-foundation; complete-workflow-pending": "תשתית חלקית; ה-workflow טרם הושלם",
}
rows = []
for r in features:
    sources = "<br>".join(f'<a href="{esc(e["url"])}" target="_blank" rel="noreferrer">{esc(e["path"])}</a> · {e["delta"]}' for e in r["evidence"])
    rows.append(f'<tr data-priority="{r["priority"]}"><td>{r["number"]}</td><td>{esc(r["group"])}</td><td><strong>{esc(r["title"])}</strong><small>{"תוספת ייעודית" if r["origin"] == "custom" else "הרחבה/שיפור של בסיס קיים"}</small></td><td>P{r["priority"]}<small>{esc(status[r["hypercutStatus"]])}</small></td><td>{esc(r["implementationStrategy"])}<p><b>אישור מעבר:</b> {esc(r["acceptance"])}</p><details><summary>ראיות בקוד הרמוט</summary><div class="sources">{sources}</div></details></td></tr>')
snap = "".join(f'<li><b>{esc(k)}</b> — ' + (f'<span>מקומי בלבד · {v["sha"][:12]}</span>' if k == "localHypercut" else f'<a href="https://github.com/{v["repository"]}/tree/{v["sha"]}">{esc(v["ref"])} · {v["sha"][:12]}</a>') + f'<small>{esc(v["subject"])}</small></li>' for k,v in snapshots.items())
base = "".join(f'<li><b>{esc(t)}</b> — {esc(d)}</li>' for t,d in baseline)
road = "".join(f'<li>{esc(s)}</li>' for s in report["roadmap"])
perf = "".join(f'<li><b>{esc(p["title"])}</b> · {esc(p["provenance"])}<br>{esc(p["requirement"])}</li>' for p in performance)
limits = "".join(f'<li>{esc(s)}</li>' for s in [
    "זו בדיקת קוד והיסטוריה, לא בדיקת הפעלה של כל היכולות. 90 השורות הן דרישות עבודה, לא 90 המצאות עצמאיות.",
    "הנתיבים וקובצי המקור בכל שורה אומתו מול הרמוט. היעדר קובץ במקור לבדו אינו הוכחה שאין שם יכולת דומה בשם אחר; ההחלטות הן מיפוי של ההתנהגות והחיבור הקיימים.",
    "נכסים ופריסטים פרטיים שנשמרו רק במחשב אינם ניתנים למנייה דרך Git. נדרש manifest נפרד כדי לוודא שכל הסאונדים, הפונטים והפריסטים המקוריים נשמרו.",
    "90 הדרישות אינן תחליף לרשימת הבסיס הקודמת בת 75 המשפחות. כאן מפרקים את התוספות/ההרחבות; שם נשמרת גם עריכה בסיסית.",
    "HyperCut ושיפורי הביצועים האחרונים כוללים קוד מקומי שלא נמצא עדיין ברמוט; רשימת הקומיטים המלאה מופיעה ב-JSON."])
document = f'''<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HyperCut — השוואת פיצ׳רים מול OpenCut הרשמי</title>
<style>body{{font:16px/1.65 system-ui,sans-serif;margin:0;background:#f5f7fa;color:#172330}}main{{max-width:1450px;margin:auto;padding:32px}}h1{{font-size:32px;margin:0}}h2{{margin-top:36px}}a{{color:#1559ad}}small{{display:block;color:#536377;font-size:13px}}.lead{{font-size:20px;max-width:1000px}}.cards{{display:flex;gap:14px;flex-wrap:wrap}}.card{{background:white;border:1px solid #d5dfe8;border-radius:10px;padding:14px 24px}}.card b{{font-size:28px;display:block}}.controls{{position:sticky;top:0;background:#f5f7fa;padding:12px 0;display:flex;gap:12px;z-index:2}}input,select{{font:inherit;border:1px solid #bac8d5;border-radius:7px;padding:10px}}input{{flex:1;min-width:80px}}table{{width:100%;border-collapse:collapse;background:white}}th,td{{padding:13px;text-align:right;vertical-align:top;border-bottom:1px solid #dce3eb}}th{{background:#213b54;color:white}}td:nth-child(3){{min-width:200px}}td:last-child{{width:49%}}td p{{margin:10px 0}}.sources{{direction:ltr;text-align:left;font:12px/1.8 monospace;overflow-wrap:anywhere}}li{{margin:9px 0}}summary{{cursor:pointer;color:#1559ad}}.table-wrap{{overflow:auto}}.note{{background:#eaf0f7;padding:18px;border-radius:10px}}[hidden]{{display:none!important}}@media print{{.controls{{display:none}}details{{display:block}}main{{padding:0}}th{{color:black;background:#eee}}}}</style>
<main><small>בדיקת מקור · 11 באוקטובר 2026 · פרויקטים חדשים בלבד</small><h1>מה צריך להעביר מ־OpenCut שלנו ל־HyperCut?</h1>
<p class="lead">מופו {len(features)} דרישות לתוספות ולהרחבות שלנו. הסטודיו המקורי של HyperFrames הוא בסיס הממשק; רוב התהליכים המיוחדים של OpenCut עדיין אינם מחוברים אליו.</p>
<div class="cards"><div class="card"><b>{len(features)}</b>דרישות להעברה/התאמה</div><div class="card"><b>{len(our_tabs)} מול {len(old_tabs)}</b>לשוניות נכסים אצלנו ובמקור</div><div class="card"><b>11</b>לשוניות נוספות — לא מדד להשלמת פיצ׳רים</div></div>
<h2>מה הושווה</h2><ul>{snap}</ul><p>העורך המקורי הועבר ל־opencut-classic לאחר תחילת השכתוב הרשמי. ההשוואה מנרמלת את תיקיית classic אצלנו מול שורש Classic הרשמי, ומשווה את ליבת Rust/API בנפרד.</p><p dir="ltr">{esc(report["statistics"]["classicDiffSummary"])}</p>
<div class="note">נמצאו תוספות שהרשימה הקודמת הסתירה בתוך כותרות כלליות: Premiere XML, קריינות מקומית, פונטים, Unified Angles, גרפיקות צמודות לטקסט, Push B-roll, רכיבי UI עם SFX ו־Parallax. אין להסיק מתפריט או מקטלוג דומה שכל אחת מהן כבר קיימת ב־HyperCut.</div>
<h2>דרישות מפורטות</h2><p>P1 = בסיס ורציפות עבודה; P2 = workflows ועיצוב; P3 = הרחבות משלימות. זהו סדר תלות מוצע, לא מדידת ROI.</p><div class="controls"><input id="search" placeholder="חיפוש פיצ׳ר, למשל Smart Takes, פונטים או SFX" aria-label="חיפוש דרישות"><select id="priority" aria-label="עדיפות"><option value="">כל העדיפויות</option value="1">P1</option><option value="2">P2</option><option value="3">P3</option></select><span id="count"></span></div><div class="table-wrap"><table><thead><tr><th>#</th><th>תחום</th><th>תוספת / הרחבה</th><th>מצב ועדיפות</th><th>מה נדרש וראיות</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>
<h2>מה לא צריך להמציא מחדש — ומה עדיין לא מחובר</h2><ul>{base}</ul><h2>ביצועים ורציפות עבודה</h2><ul>{perf}</ul><h2>סדר עבודה מוצע</h2><ol>{road}</ol><h2>גבולות הבדיקה</h2><ul>{limits}</ul><p>נתונים מלאים, מזהי presets מפורשים, diff מנורמל וקומיטים מקומיים: <a href="comparison.json">comparison.json</a>. דרישות לעריכה: <a href="requirements.tsv">requirements.tsv</a>.</p></main>
<script>const rows=[...document.querySelectorAll('tbody tr')],s=document.querySelector('#search'),p=document.querySelector('#priority'),c=document.querySelector('#count');function filter(){{let n=0;for(const r of rows){{r.hidden=!(r.textContent.toLowerCase().includes(s.value.toLowerCase())&&(!p.value||r.dataset.priority===p.value));if(!r.hidden)n++}}c.textContent=n+' / '+rows.length}}s.addEventListener('input',filter);p.addEventListener('change',filter);filter();</script></html>'''
(HERE / "comparison.html").write_text(document)
print(json.dumps(dict(requirements=len(features), sourceReferences=sum(len(f["evidence"]) for f in features),
                      origins=report["statistics"]["origins"], panels=report["panels"]["added"],
                      localOnlyCommits=len(local_commits)), ensure_ascii=False))
