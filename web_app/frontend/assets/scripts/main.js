/* ========================================
   Config
   ======================================== */
const CFG = {
    API: "",
    DETECT: "/detect",
    MODELS: "/api/recognition/models",
    HEALTH: "/api/health",
    MAX_BYTES: 10 * 1024 * 1024, // M-IN.2 — confirm the agreed maximum
    MAX_SIDE: 1280,              // preview only; upload the original image
    LOW: 0.6,                    // M-DC.6 low-confidence threshold
    TIMEOUT: 120000,
    TARGET: 3,
    DEMO: new URLSearchParams(location.search).has("demo")
    // open /?demo to try the UI without a backend
};

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let S = {
    file: null,
    prep: null,
    parts: [],
    sel: 0,
    base: null,
    model: "",
    secs: 0,
    version: "",
    record: ""
};


/* ========================================
   Steps / small helpers
   ======================================== */
function step(n) {
    document.querySelectorAll("#steps li").forEach((li, i) => {
        li.className = i + 1 < n ? "done" : i + 1 === n ? "on" : "";
    });
}

let working = false;
let fileRequest = 0;

function sync() {
    $("go").disabled = working || !S.file || !$("model").value;
    step(
        !$("results").hidden ? 4 :
        S.file && $("model").value ? 3 :
        $("model").value ? 2 : 1
    );
}

function banner(kind, text) {
    const d = document.createElement("div");

    d.className = "banner " + kind;
    d.textContent = text;

    $("msg").replaceChildren(d);
}

function busy(on) {
    working = on;
    ["model", "browse", "shoot", "reset", "f1", "f2", "hclr"].forEach(id => $(id).disabled = on);
    sync();
    $("go").textContent = on ? "Analyzing..." : "Start recognition";
}

function loadImg(src) {
    return new Promise((ok, no) => {
        const i = new Image();

        i.onload = () => ok(i);
        i.onerror = no;
        i.src = src;
    });
}


/* ========================================
   Init: models, server status, demo flag
   ======================================== */
(async () => {
    let m = CFG.DEMO ? ["E877"] : [];

    if (!CFG.DEMO) {
        try {
            const r = await fetch(CFG.API + CFG.MODELS);

            if (r.ok) {
                const j = await r.json();
                const a = Array.isArray(j) ? j : j.models;

                if (Array.isArray(a)) m = a;
            }
        } catch {}
    }

    if (!CFG.DEMO && !m.length) {
        $("merr").textContent = "No printer models loaded. Check your database and API connection, then reload.";
    }

    m.forEach(x => {
        const o = document.createElement("option");

        o.value = o.textContent = x;
        $("model").append(o);
    });
})();

if (CFG.DEMO) {
    $("demo").hidden = false;
} else {
    fetch(CFG.API + CFG.HEALTH)
        .then(r => {
            $("dot").className = r.ok ? "dot on" : "dot off";
            $("dot").title = r.ok ? "Catalogue API connected" : "Catalogue API unavailable";
        })
        .catch(() => {
            $("dot").className = "dot off";
        });
}

$("model").addEventListener("change", () => {
    $("merr").textContent = "";
    sync();
});


/* ========================================
   File selection + validation (M-IN.1-3)
   ======================================== */
$("browse").onclick = () => $("f1").click();
$("shoot").onclick = () => $("f2").click();

[$("f1"), $("f2")].forEach(i => {
    i.onchange = () => {
        if (i.files[0]) setFile(i.files[0]);
    };
});

["dragenter", "dragover"].forEach(e => {
    $("drop").addEventListener(e, ev => {
        ev.preventDefault();
        $("drop").classList.add("drag");
    });
});

["dragleave", "drop"].forEach(e => {
    $("drop").addEventListener(e, ev => {
        ev.preventDefault();
        $("drop").classList.remove("drag");
    });
});

$("drop").addEventListener("drop", e => {
    if (e.dataTransfer.files[0]) {
        setFile(e.dataTransfer.files[0]);
    }
});

async function prepare(file) {
    // downscale + fix phone EXIF rotation by redrawing through a canvas

    const bmp = await createImageBitmap(file);
    const s = Math.min(
        1,
        CFG.MAX_SIDE / Math.max(bmp.width, bmp.height)
    );

    const c = document.createElement("canvas");

    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);

    c.getContext("2d").drawImage(
        bmp, 0, 0, c.width, c.height
    );

    return {
        canvas: c,
        blob: await new Promise(r => c.toBlob(r, "image/jpeg", 0.92))
    };
}

async function setFile(f) {
    if (working) return;
    $("reset").onclick();
    const request = fileRequest;
    $("ferr").textContent = "";

    if (!["image/jpeg", "image/png"].includes(f.type)) {
        $("ferr").textContent =
            "Unsupported file type. Please upload a JPG or PNG image.";
        return;
    }

    if (f.size > CFG.MAX_BYTES) {
        $("ferr").textContent =
            "File is too large. Maximum size is " +
            CFG.MAX_BYTES / 1048576 + " MB.";
        return;
    }

    try {
        const preview = await prepare(f);
        if (request !== fileRequest) return;
        S.prep = preview;
    } catch {
        if (request !== fileRequest) return;
        $("ferr").textContent =
            "This file could not be read as an image.";
        return;
    }

    S.file = f;
    $("pv").src = URL.createObjectURL(f);
    $("pv").hidden = false;
    $("dl").textContent = f.name;
    $("reset").hidden = false;

    sync();
}


/* ========================================
   API layer: accepts the unified contract, PV-ML-HPPK and HPSubPick responses
   ======================================== */
function box(b) {
    // -> [x, y, w, h] top-left, normalized 0-1
    if (Array.isArray(b)) {
        const [cx, cy, w, h] = b;

        return [cx - w / 2, cy - h / 2, w, h];
    }

    // xywhn (centre) as stored by PV-ML
    if (b && "x_pct" in b) {
        return [b.x_pct, b.y_pct, b.w_pct, b.h_pct];
    }

    return null;
}

function fromJson(d) {
    const parts = Array.isArray(d.parts)
        ? d.parts.map(p => ({
            id: p.prediction_id,
            fb: p.user_feedback,
            cls: p.class_name || p.cls,
            num: p.part_number || p.cls,
            desc: p.description || p.name || "",
            conf: p.confidence,
            box: box(p.bbox_norm || p),
            compat: p.compatibility
        }))
        : (d.conf || []).map((c, i) => ({
            cls: d.cls[i],
            num: d.cls[i],
            desc: (d.desc || [])[i] || "",
            conf: c,
            box: box((d.bboxes || [])[i])
        }));

    return {
        parts,
        serverImage: d.image
            ? "data:image/jpeg;base64," + d.image
            : null,
        version: d.model_version,
        record: d.record_id,
        model: d.printer_model,
        source: d.source_file,
        imageUrl: d.image_url
    };
}

function demo() {
    return {
        version: "demo",
        parts: [
            {
                cls: "JC97-05149A",
                num: "JC97-05149A",
                desc: "Laser scanner unit (LSU)",
                conf: .93,
                box: [.08, .1, .38, .3]
            },
            {
                cls: "933853-011",
                num: "933853-011",
                desc: "Hard disk 500GB SED",
                conf: .81,
                box: [.55, .48, .32, .3]
            },
            {
                cls: "6CF14-67011",
                num: "6CF14-67011",
                desc: "Main PCA (Formatter)",
                conf: .46,
                box: [.12, .6, .3, .3]
            }
        ]
    };
}

async function callApi(blob, name, model) {
    if (CFG.DEMO) {
        await sleep(700);
        return demo();
    }

    const fd = new FormData();

    fd.append(
        "file",
        blob,
        name
    );

    fd.append("printer_model", model);

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), CFG.TIMEOUT);

    let res;

    try {
        res = await fetch(CFG.API + CFG.DETECT, {
            method: "POST",
            body: fd,
            signal: ctl.signal
        });
    } catch (e) {
        throw new Error(
            e.name === "AbortError"
                ? "The server took too long to respond. Please try again."
                : "Could not reach the server. Check your connection and try again."
        );
    } finally {
        clearTimeout(t);
    }

    if (!res.ok) {
        let d = "";

        try {
            d = (await res.json()).detail;
        } catch {}

        throw new Error(
            d ||
            ({
                413: "The file is too large for the server.",
                415: "The server does not accept this file type."
            })[res.status] ||
            "The server could not process this image (error " +
            res.status + ")."
        );
    }

    return fromJson(await res.json());
}


/* ========================================
   Run
   ======================================== */
$("go").onclick = async () => {
    if (working) return;
    $("msg").replaceChildren();
    $("results").hidden = true;

    if (!$("model").value) {
        $("merr").textContent =
            "Please choose a printer model first.";

        $("model").focus();
        return;
    }

    // M-ER.1
    if (!S.file) {
        $("ferr").textContent =
            "Please select an image to analyze.";
        return;
    }

    busy(true);

    const t0 = performance.now();

    try {
        const r = await callApi(
            S.file,
            S.file.name,
            $("model").value
        );

        S.secs = (performance.now() - t0) / 1000;

        await show(r);
    } catch (e) {
        banner("err", e.message);
    }

    // M-ER.2

    finally {
        busy(false);
        sync();
    }
};

async function show(r) {
    S.parts = r.parts
        .filter(p => typeof p.conf === "number")
        .sort((a, b) => b.conf - a.conf);

    S.model = r.model || $("model").value;
    S.version = r.version || "";
    S.record = r.record || "";
    S.sel = 0;
    S.base = r.imageUrl ? await loadImg(r.imageUrl) : S.prep.canvas;
    if (!S.parts.length) {
        banner("info", "No printer part was detected. The result has been saved.");
    }

    $("count").textContent =
        S.parts.length +
        (S.parts.length === 1 ? " part detected" : " parts detected");

    $("meta").textContent =
        S.model + " · " +
        (S.secs ? S.secs.toFixed(1) + " s" : "Saved result") +
        (S.secs > CFG.TARGET
            ? " (over the " + CFG.TARGET + " s target)"
            : "") +
        (S.version ? " · model " + S.version : "");

    const L = $("list");
    L.replaceChildren();

    S.parts.forEach((p, i) => {
        const row = document.createElement("div");
        const l = document.createElement("span");
        const b = document.createElement("b");
        const s = document.createElement("small");
        const c = document.createElement("span");

        row.className = "part";
        row.dataset.i = i;

        b.textContent = p.num;
        s.textContent = p.desc;

        l.append(b, s);

        c.textContent = Math.round(p.conf * 100) + "%";

        if (p.conf < CFG.LOW) {
            const g = document.createElement("span");

            g.className = "badge";
            g.textContent = "Low confidence";

            c.prepend(g);
        }

        // M-DC.6
        row.append(l, c);
        row.onclick = () => select(i);

        L.append(row);
    });

    $("results").hidden = false;

    zoom(1);
    if (S.parts.length) select(0);
    else {
        $("detail").replaceChildren();
        render();
    }

    $("results").scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
}


/* ========================================
   Review: overlay, selection, spec panel (M-IL.2-4)
   ======================================== */
function select(i) {
    S.sel = i;

    document.querySelectorAll(".part").forEach(r => {
        r.classList.toggle("sel", +r.dataset.i === i);
    });

    const p = S.parts[i];
    const d = $("detail");

    d.replaceChildren();

    [
        ["Part number", p.num],
        ["Description", p.desc],
        ["Mfg. part number", p.mfg],
        ["Class", p.cls !== p.num ? p.cls : ""],
        [
            "Confidence",
            (p.conf * 100).toFixed(1) + "%" +
            (p.conf < CFG.LOW ? " — low, please verify" : "")
        ],
        ["Printer model", S.model],
        ["Compatible with", (p.compat || []).join(", ")]
    ].forEach(([k, v]) => {
        if (!v) return;

        const r = document.createElement("div");
        const a = document.createElement("span");
        const b = document.createElement("span");

        a.textContent = k;
        b.textContent = v;

        r.append(a, b);
        d.append(r);
    });

    feedbackUI(d, p);
    render();
}

function render() {
    const cv = $("cv");
    const b = S.base;
    const w = b.naturalWidth || b.width;
    const h = b.naturalHeight || b.height;

    cv.width = w;
    cv.height = h;

    const g = cv.getContext("2d");

    g.drawImage(b, 0, 0, w, h);

    const fs = Math.max(13, w / 48);

    g.font = "600 " + fs + "px sans-serif";
    g.textBaseline = "top";

    S.parts.forEach((p, i) => {
        if (!p.box) return;

        const [x, y, bw, bh] = p.box;
        const low = p.conf < CFG.LOW;
        const sel = i === S.sel;

        g.lineWidth = sel
            ? Math.max(4, w / 180)
            : Math.max(2, w / 320);

        g.strokeStyle = low
            ? "#E0A100"
            : sel
                ? "#0074C8"
                : "#2BB673";

        g.setLineDash(low ? [fs / 1.5, fs / 2] : []);

        g.strokeRect(x * w, y * h, bw * w, bh * h);

        if (sel) {
            const t = p.num + " " + Math.round(p.conf * 100) + "%";
            const tw = g.measureText(t).width + 10;
            const ty = Math.max(0, y * h - fs - 8);

            g.setLineDash([]);
            g.fillStyle = g.strokeStyle;

            g.fillRect(x * w, ty, tw, fs + 8);

            g.fillStyle = "#fff";
            g.fillText(t, x * w + 5, ty + 4);
        }
    });
}

$("cv").addEventListener("click", e => {
    const r = e.target.getBoundingClientRect();

    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;

    let best = -1;
    let area = 9;

    S.parts.forEach((p, i) => {
        if (!p.box) return;

        const [bx, by, bw, bh] = p.box;

        if (
            x >= bx &&
            x <= bx + bw &&
            y >= by &&
            y <= by + bh &&
            bw * bh < area
        ) {
            area = bw * bh;
            best = i;
        }
    });

    if (best >= 0) select(best);
});

window.addEventListener("resize", () => {
    if (!$("results").hidden) render();
});


/* ========================================
   Export package: annotated.png + results.json + results.csv (M-EX.1-3)
   ======================================== */
$("exp").onclick = () => {
    if (!S.record) {
        banner("info", "Simulated results are not saved. Run real recognition first.");
        return;
    }
    window.location.href = "/api/results/" + S.record + "/export";
};

/* ========================================
   Reset
   ======================================== */
$("reset").onclick = () => {
    fileRequest++;
    URL.revokeObjectURL($("pv").src);
    S.record = "";
    S.file = S.prep = null;
    S.parts = [];

    ["f1", "f2"].forEach(i => {
        $(i).value = "";
    });

    $("pv").hidden = true;
    $("dl").textContent = "Drag and drop a printer photo here";

    $("msg").replaceChildren();

    $("results").hidden = true;
    $("ferr").textContent = $("merr").textContent = "";
    $("reset").hidden = true;

    sync();
};


/* ========================================
   Expansion: tabs, catalogue, history, feedback, zoom
   ======================================== */
document.querySelectorAll("#tabs button").forEach(b => {
    b.onclick = () => {
        document.querySelectorAll("#tabs button").forEach(x => {
            x.classList.toggle("on", x === b);
        });

        ["rec", "cat", "his"].forEach(v => {
            $("v-" + v).hidden = v !== b.dataset.v;
        });

        if (b.dataset.v === "cat") window.Catalogue.load();
        if (b.dataset.v === "his") renderHistory();
    };
});

async function openHistory(id) {
    if (working) return;
    busy(true);
    try {
        const response = await fetch("/api/results/" + id);
        if (!response.ok) throw new Error("Could not reopen this recognition.");
        const result = fromJson(await response.json());
        $("reset").onclick();
        S.secs = 0;
        document.querySelector('#tabs button[data-v="rec"]').click();
        await show(result);
    } catch (error) {
        banner("err", error.message);
    } finally {
        busy(false);
    }
}

async function renderHistory() {
    const list = $("hlist");
    list.textContent = "Loading saved recognitions…";
    try {
        const response = await fetch("/api/results", {cache: "no-store"});
        if (!response.ok) throw new Error("Could not load history.");
        const records = await response.json();
        list.replaceChildren();
        if (!records.length) list.textContent = "No saved recognitions for this browser.";
        for (const record of records) {
            const row = document.createElement("div");
            row.className = "hrow";
            const text = document.createElement("span");
            text.textContent = record.created + " · " + record.source_file + " · " +
                (record.parts.map(p => p.part_number).join(", ") || "No part detected");
            const open = document.createElement("button");
            open.textContent = "Open result";
            open.onclick = () => openHistory(record.record_id);
            const download = document.createElement("a");
            download.textContent = "Download ZIP";
            download.href = "/api/results/" + record.record_id + "/export";
            row.append(text, open, download);
            list.append(row);
        }
    } catch (error) {
        list.textContent = error.message;
    }
}

$("hclr").onclick = async () => {
    if (working || !confirm("Delete your saved recognitions, feedback and images?")) return;
    busy(true);
    try {
        const response = await fetch("/api/results", {method: "DELETE"});
        if (!response.ok) throw new Error("Could not clear history.");
        $("reset").onclick();
        await renderHistory();
    } catch (error) {
        banner("err", error.message);
    } finally {
        busy(false);
    }
};

let feedbackPartsPromise;

function loadFeedbackParts() {
    if (CFG.DEMO) {
        return Promise.resolve(demo().parts.map(p => ({
            serial_number: p.num,
            part_desc: p.desc
        })));
    }

    if (!feedbackPartsPromise) {
        feedbackPartsPromise = (async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), CFG.TIMEOUT);
            const parts = [];

            try {
                for (let page = 1; ; page++) {
                    const params = new URLSearchParams({ page, page_size: 100 });
                    const response = await fetch(
                        CFG.API + "/api/catalogue/parts?" + params,
                        { signal: controller.signal, cache: "no-store" }
                    );

                    if (!response.ok) throw new Error("Catalogue request failed.");

                    const data = await response.json();
                    if (!Array.isArray(data.items) || !Number.isInteger(data.total) || data.total < 0) {
                        throw new Error("Invalid catalogue response.");
                    }

                    parts.push(...data.items);
                    if (parts.length >= data.total) return parts;
                    if (!data.items.length) throw new Error("Incomplete catalogue response.");
                }
            } finally {
                clearTimeout(timeout);
            }
        })().catch(error => {
            feedbackPartsPromise = undefined;
            throw error;
        });
    }

    return feedbackPartsPromise;
}

async function feedbackUI(d, p) {
    const w = document.createElement("div");
    const sel = document.createElement("select");
    const note = document.createElement("small");

    w.className = "fb";

    sel.append(
        new Option(
            "Flag as incorrect (choose the correct part)",
            ""
        )
    );

    const unknown = new Option("Not a printer part / unknown", "none");
    sel.append(unknown);

    sel.value = p.fb || "";

    let choicesFailed = false;
    const updateNote = () => {
        note.textContent = p.fb
            ? "Saved to the database for review."
            : choicesFailed
                ? "Part choices could not be loaded. You can still mark this result as unknown."
                : "";
    };
    updateNote();

    const recordId = S.record;
    sel.disabled = !recordId || !p.id;
    sel.onchange = async () => {
        const value = sel.value;
        sel.disabled = true;
        note.textContent = "Saving…";
        try {
            const response = await fetch("/api/results/" + recordId + "/predictions/" + p.id + "/feedback", {
                method: "PUT",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({value})
            });
            if (!response.ok) throw new Error("Feedback could not be saved.");
            p.fb = value || undefined;
            updateNote();
        } catch (error) {
            sel.value = p.fb || "";
            note.textContent = error.message;
        } finally {
            sel.disabled = false;
        }
    };

    w.append(sel, note);
    d.append(w);

    sel.setAttribute("aria-busy", "true");
    try {
        const parts = await loadFeedbackParts();
        const seen = new Set();

        for (const part of parts) {
            if (seen.has(part.serial_number)) continue;
            seen.add(part.serial_number);
            sel.insertBefore(
                new Option(part.serial_number + " | " + part.part_desc, part.serial_number),
                unknown
            );
        }
        sel.value = p.fb || "";
    } catch {
        choicesFailed = true;
        updateNote();
    } finally {
        sel.removeAttribute("aria-busy");
    }
}

let Z = 1;

function zoom(z) {
    Z = Math.max(1, Math.min(4, z));

    $("cv").style.width = Z * 100 + "%";
}

$("zi").onclick = () => zoom(Z + .5);
$("zo").onclick = () => zoom(Z - .5);
$("zr").onclick = () => zoom(1);

sync();