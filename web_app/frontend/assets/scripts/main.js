/* ========================================
   Config
   ======================================== */
const CFG = {
    API: "",
    DETECT: "/detect",
    MODELS: "/api/recognition/models",
    HEALTH: "/api/health",
    MAX_BYTES: 10 * 1024 * 1024, // M-IN.2 — confirm the agreed maximum
    MAX_SIDE: 1280,              // photos are downscaled before upload to protect the 3 s target
    LOW: 0.6,                    // M-DC.6 low-confidence threshold
    TIMEOUT: 30000,
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

function sync() {
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
    $("go").disabled = on;
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
        S.prep = await prepare(f);
    } catch {
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
        record: d.record_id
    };
}

async function fromHPSubPick(blob) {
    const bx = (
        await (await fetch(CFG.API + "/boxes")).json()
    ).boxes || [];

    const parts = await Promise.all(
        bx.map(async x => {
            let i = {};

            try {
                i = await (
                    await fetch(
                        CFG.API + "/api/part-info/" +
                        encodeURIComponent(x.class_name)
                    )
                ).json();
            } catch {}

            return {
                cls: x.class_name,
                num: i.part_number || x.class_name,
                desc: i.name || i.description || "",
                compat: i.compatibility,
                conf: x.confidence,
                box: box(x)
            };
        })
    );

    return {
        parts,
        serverImage: URL.createObjectURL(blob)
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
        name.replace(/\.\w+$/, "") + ".jpg"
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

    return (res.headers.get("content-type") || "").startsWith("image/")
        ? fromHPSubPick(await res.blob())
        : fromJson(await res.json());
}


/* ========================================
   Run
   ======================================== */
$("go").onclick = async () => {
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
            S.prep.blob,
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

    // Part numbers, descriptions and compatibility come from the detection API.
    if (!S.parts.length) {
        banner(
            "info",
            "No printer part was detected in this image. Try a clearer or closer photo, and check that the selected printer model is correct."
        );
        return;
    }

    // M-ER.3
    S.base = !S.parts.some(p => p.box) && r.serverImage
        ? await loadImg(r.serverImage)
        : S.prep.canvas;

    S.model = $("model").value;
    S.version = r.version || "";
    S.record = r.record || "";
    S.sel = 0;

    $("count").textContent =
        S.parts.length +
        (S.parts.length === 1 ? " part detected" : " parts detected");

    $("meta").textContent =
        S.model + " · " +
        S.secs.toFixed(1) + " s" +
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
    select(0);
    saveHistory();

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
$("exp").onclick = async () => {
    const enc = new TextEncoder();

    const png = new Uint8Array(
        await (
            await new Promise(r => $("cv").toBlob(r, "image/png"))
        ).arrayBuffer()
    );

    const rows = S.parts.map(p => ({
        part_number: p.num,
        class: p.cls,
        description: p.desc,
        confidence: +p.conf.toFixed(4),
        low_confidence: p.conf < CFG.LOW,
        mfg_part_number: p.mfg || null,
        user_feedback: p.fb || null,
        bbox_norm_xywh: p.box
            ? p.box.map(v => +v.toFixed(4))
            : null
    }));

    const q = v =>
        '"' + String(v ?? "").replace(/"/g, '""') + '"';

    const csv =
        "part_number,class,description,confidence,low_confidence,printer_model\n" +
        rows.map(r => [
            q(r.part_number),
            q(r.class),
            q(r.description),
            r.confidence,
            r.low_confidence,
            q(S.model)
        ].join(",")).join("\n");

    const meta = {
        created: new Date().toISOString(),
        printer_model: S.model,
        source_file: S.file.name,
        model_version: S.version || null,
        record_id: S.record || null,
        response_seconds: +S.secs.toFixed(2),
        parts: rows
    };

    const z = makeZip([
        {
            name: "annotated.png",
            data: png
        },
        {
            name: "results.json",
            data: enc.encode(JSON.stringify(meta, null, 2))
        },
        {
            name: "results.csv",
            data: enc.encode("\ufeff" + csv)
        }
    ]);

    const a = document.createElement("a");

    a.href = URL.createObjectURL(z);
    a.download = "detection_results.zip";

    document.body.append(a);

    a.click();
    a.remove();

    step(5);
};

function makeZip(files) {
    const T = new Uint32Array(256);

    for (let n = 0; n < 256; n++) {
        let c = n;

        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        }

        T[n] = c >>> 0;
    }

    const crc = d => {
        let c = 0xFFFFFFFF;

        for (let i = 0; i < d.length; i++) {
            c = T[(c ^ d[i]) & 255] ^ (c >>> 8);
        }

        return (c ^ 0xFFFFFFFF) >>> 0;
    };

    const enc = new TextEncoder();
    const loc = [];
    const cen = [];

    let off = 0;

    files.forEach(f => {
        const nm = enc.encode(f.name);
        const sz = f.data.length;
        const c = crc(f.data);

        const lh = new DataView(new ArrayBuffer(30));
        const ch = new DataView(new ArrayBuffer(46));

        lh.setUint32(0, 0x04034b50, true);
        lh.setUint16(4, 20, true);
        lh.setUint16(12, 33, true);
        lh.setUint32(14, c, true);
        lh.setUint32(18, sz, true);
        lh.setUint32(22, sz, true);
        lh.setUint16(26, nm.length, true);

        ch.setUint32(0, 0x02014b50, true);
        ch.setUint16(4, 20, true);
        ch.setUint16(6, 20, true);
        ch.setUint16(14, 33, true);
        ch.setUint32(16, c, true);
        ch.setUint32(20, sz, true);
        ch.setUint32(24, sz, true);
        ch.setUint16(28, nm.length, true);
        ch.setUint32(42, off, true);

        loc.push(
            new Uint8Array(lh.buffer),
            nm,
            f.data
        );

        cen.push(
            new Uint8Array(ch.buffer),
            nm
        );

        off += 30 + nm.length + sz;
    });

    const cs = cen.reduce((s, a) => s + a.length, 0);
    const e = new DataView(new ArrayBuffer(22));

    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, files.length, true);
    e.setUint16(10, files.length, true);
    e.setUint32(12, cs, true);
    e.setUint32(16, off, true);

    return new Blob(
        [...loc, ...cen, new Uint8Array(e.buffer)],
        { type: "application/zip" }
    );
}


/* ========================================
   Reset
   ======================================== */
$("reset").onclick = () => {
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

const HK = "kamero.history.v1";

function hist() {
    try {
        return JSON.parse(localStorage.getItem(HK)) || [];
    } catch {
        return [];
    }
}

function saveHistory() {
    const cv = $("cv");
    const k = 160 / Math.max(cv.width, cv.height);
    const c = document.createElement("canvas");

    c.width = Math.round(cv.width * k);
    c.height = Math.round(cv.height * k);

    c.getContext("2d").drawImage(
        cv, 0, 0, c.width, c.height
    );

    const e = {
        t: Date.now(),
        model: S.model,
        file: S.file.name,
        secs: +S.secs.toFixed(1),
        img: c.toDataURL("image/jpeg", 0.6),
        parts: S.parts.map(p => [
            p.num,
            p.desc,
            +p.conf.toFixed(3)
        ])
    };

    try {
        localStorage.setItem(
            HK,
            JSON.stringify([e, ...hist()].slice(0, 20))
        );
    } catch {}
}

function renderHistory() {
    const L = $("hlist");
    const h = hist();

    L.replaceChildren();

    if (!h.length) {
        const p = document.createElement("p");

        p.className = "meta";
        p.textContent =
            "No recognitions yet. Results from this device will appear here.";

        L.append(p);
        return;
    }

    h.forEach(e => {
        const r = document.createElement("div");
        const i = new Image();
        const t = document.createElement("div");
        const b = document.createElement("b");
        const s = document.createElement("small");
        const u = document.createElement("small");

        r.className = "hrow";

        i.src = e.img;
        i.alt = "";

        b.textContent = e.file;

        s.textContent =
            new Date(e.t).toLocaleString() + " · " +
            e.model + " · " +
            e.secs + " s";

        u.textContent = e.parts
            .map(p => p[0] + " (" + Math.round(p[2] * 100) + "%)")
            .join(", ");

        t.append(b, s, u);
        r.append(i, t);

        L.append(r);
    });
}

$("hclr").onclick = () => {
    try {
        localStorage.removeItem(HK);
    } catch {}

    renderHistory();
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
            ? "Saved in the export for review."
            : choicesFailed
                ? "Part choices could not be loaded. You can still mark this result as unknown."
                : "";
    };
    updateNote();

    sel.onchange = () => {
        p.fb = sel.value || undefined;

        updateNote();
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