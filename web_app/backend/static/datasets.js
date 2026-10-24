"use strict";
const english = new URLSearchParams(location.search).get("lang") === "en";
document.documentElement.lang = english ? "en" : "ko";
if (english) {
  document.querySelectorAll("[data-en]").forEach(node => { node.textContent = node.dataset.en; });
}
const words = english
  ? {error: "Unable to load: ", files: " files", empty: "No files", all: "All parts", noDataset: "No datasets registered. Import an inventory first."}
  : {error: "조회 실패: ", files: "개 파일", empty: "파일 없음", all: "전체 부품", noDataset: "등록된 데이터셋이 없습니다. 먼저 inventory를 가져오세요."};
const el = id => document.getElementById(id);
let offset = 0, total = 0, requestVersion = 0;
async function get(url) {
  if (window.publicCatalogueGet) return window.publicCatalogueGet(url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(words.error + response.status);
  return response.json();
}
function fail(error) { el("status").textContent = error.message; }
async function showAssets() {
  const version = ++requestVersion;
  const params = new URLSearchParams({offset, limit: 50});
  if (el("parts").value) params.set("part_no", el("parts").value);
  const data = await get("/api/datasets/" + el("datasets").value + "/assets?" + params);
  if (version !== requestVersion) return;
  total = data.total;
  el("rows").replaceChildren();
  for (const asset of data.assets) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    const url = new URL(asset.source_url);
    if (url.protocol === "https:" && url.hostname === "drive.google.com") {
      const a = document.createElement("a");
      a.href = url.href; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = asset.name; td.append(a);
    } else { td.textContent = asset.name; }
    tr.append(td);
    for (const text of [asset.folder, asset.parts.map(p => p.part_no).join(", "), (asset.size_bytes / 1e6).toFixed(2) + " MB"]) {
      const cell = document.createElement("td"); cell.textContent = text; tr.append(cell);
    }
    el("rows").append(tr);
  }
  el("count").textContent = total ? (offset + 1) + "–" + Math.min(offset + 50, total) + " / " + total + words.files : words.empty;
  el("prev").disabled = offset === 0; el("next").disabled = offset + 50 >= total;
}
async function selectDataset() {
  offset = 0;
  const base = "/api/datasets/" + el("datasets").value;
  const [s, p] = await Promise.all([get(base + "/summary"), get(base + "/parts")]);
  el("status").textContent = english
    ? s.parts + " parts · " + s.folders + " folders · " + s.files + " video entries · " + (s.total_bytes / 1e9).toFixed(2) + " GB\n" + s.duplicate_candidate_groups + " duplicate candidate groups · Metadata only"
    : s.parts + "개 부품 · " + s.folders + "개 폴더 · " + s.files + "개 영상 항목 · " + (s.total_bytes / 1e9).toFixed(2) + " GB\n중복 후보 그룹 " + s.duplicate_candidate_groups + "개 · 파일 정보만 등록";
  el("parts").replaceChildren(new Option(words.all, ""));
  for (const part of p.parts) el("parts").append(new Option("Part_" + part.part_no + " · " + part.svc_number + " · " + part.description, part.part_no));
  await showAssets();
}
el("datasets").onchange = () => selectDataset().catch(fail);
el("parts").onchange = () => { offset = 0; showAssets().catch(fail); };
el("prev").onclick = () => { offset = Math.max(0, offset - 50); showAssets().catch(fail); };
el("next").onclick = () => { offset += 50; showAssets().catch(fail); };
(async () => {
  const data = await get("/api/datasets");
  if (!data.datasets.length) { el("status").textContent = words.noDataset; return; }
  for (const d of data.datasets) el("datasets").append(new Option(d.name, d.id));
  await selectDataset();
})().catch(fail);
