import { ensureHfIds } from "@hyperframes/parsers/hf-ids";
export const initialHTML = ensureHfIds(`<!doctype html><html><head><meta charset="utf-8">
<script src="/gsap.min.js"></script><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111827}
#title{position:absolute;left:120px;top:390px;font:700 100px Arial;color:white}
#subtitle{position:absolute;left:128px;top:525px;font:32px Arial;color:#94a3b8}
</style></head><body><div id="root-composition" data-composition-id="hypercut" data-width="1920" data-height="1080" data-duration="10" style="width:100%;height:100%;position:relative">
<div id="title" class="clip" data-start="0" data-duration="10" data-track-index="0">HyperCut</div>
<div id="subtitle" class="clip" data-start="0" data-duration="10" data-track-index="1">Your next edit starts here.</div>
</div><script>window.__timelines=window.__timelines||{};window.__timelines.hypercut=gsap.timeline({paused:true}).to({}, {duration:10});</script></body></html>`);
