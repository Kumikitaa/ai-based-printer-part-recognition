/* ========================================
   Config
   ======================================== */
const CFG = {
    API: "",
    DETECT: "/api/v1/analyze",
    MODELS: "/api/models",
    HEALTH: "/api/health",
    MAX_BYTES: 10 * 1024 * 1024, // M-IN.2 — confirm the agreed maximum
    MAX_SIDE: 1280,              // preview only; upload preserves the original file
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

const PARTS = []; // Server catalogue; never infer model labels from dataset part numbers.
let working = false;
let recognitionReady = false;
let catalogueRequest = 0;

async function loadCatalogue() {
    const request = ++catalogueRequest;
    const printer = $("catalog-model").value;
    $("catalog-status").textContent = "Loading catalogue…";
    try {
        const response = await fetch("/api/parts?printer_model=" + encodeURIComponent(printer));
        if (!response.ok) throw new Error("Could not load the parts catalogue.");
        const data = await response.json();
        if (request !== catalogueRequest) return;
        PARTS.splice(0, PARTS.length, ...data.parts.map(p => [p.part_number, "", p.description]));
        renderCat();
        $("catalog-status").textContent = printer === "legacy"
            ? "Reference catalogue for the connected legacy model."
            : printer + " source parts. Catalogue availability does not mean all parts are recognized by the connected model.";
    } catch (error) {
        if (request !== catalogueRequest) return;
        PARTS.splice(0); renderCat();
        $("catalog-status").textContent = error.message;
    }
}
$("catalog-model").addEventListener("change", loadCatalogue);



/* ========================================
   Steps / small helpers
   ======================================== */
function step(n) {
    document.querySelectorAll("#steps li").forEach((li, i) => {
        li.className = i + 1 < n ? "done" : i + 1 === n ? "on" : "";
    });
}

function sync() {
    const hasModel = Boolean($("model").value);
    const ready = hasModel && Boolean(S.file) && recognitionReady;
    $("go").disabled = working || !ready;

    if (!$("results").hidden) step(4);
    else if (ready) step(3);
    else if (hasModel) step(2);
    else step(1);
}

function banner(kind, text) {
    const d = document.createElement("div");

    d.className = "banner " + kind;
    d.textContent = text;

    $("msg").replaceChildren(d);
}

function busy(on) {
    working = on;
    ["model", "browse", "shoot", "reset", "f1", "f2"].forEach(id => $(id).disabled = on);
    sync();
    $("go").textContent = on ? "Analyzing…" : "Start recognition";
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
    $("go").disabled = true;
    try {
        await loadCatalogue();
        const r = await fetch(CFG.API + CFG.MODELS);
        if (!r.ok) throw new Error("Could not load recognition scopes.");
        const data = await r.json();
        const scopes = CFG.DEMO ? ["Simulated demo (not a trained E786 model)"] : data.models;
        $("model").replaceChildren();
        scopes.forEach(x => $("model").append(new Option(x, x)));
        recognitionReady = scopes.length > 0;
        if (!recognitionReady) {
            $("model").append(new Option("Recognition weights not installed", ""));
            banner("info", data.message || "Catalogue browsing is available. Recognition is unavailable.");
        } else {
            banner("info", CFG.DEMO ? "Simulated results only; no AI model is used." : data.message);
        }
        busy(false);
        sync();
    } catch (e) {
        banner("err", e.message + " Check the backend and refresh.");
    }
})();

if (CFG.DEMO) {
    $("demo").hidden = false;
} else {
    fetch(CFG.API + CFG.HEALTH)
        .then(r => {
            if (r.ok) $("dot").className = "dot on";
        })
        .catch(() => {
            $("dot").className = "dot off";
        });
}

$("model").addEventListener("change", () => {
    $("reset").onclick();
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

let validationRequest = 0;

async function setFile(f) {
    if (working) return;
    $("reset").onclick();
    const request = validationRequest;
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
        banner("info", "Checking image…");
        if (!CFG.DEMO) {
            const form = new FormData();
            form.append("file", f);
            form.append("printer_model", $("model").value);
            const response = await fetch("/api/v1/validate", {method: "POST", body: form});
            if (!response.ok) throw new Error((await response.json()).detail);
        }
        const preview = await prepare(f);
        if (request !== validationRequest) return;
        S.prep = preview;
        banner("info", "Ready for recognition.");
    } catch (error) {
        if (request !== validationRequest) return;
        $("msg").replaceChildren();
        $("ferr").textContent = error.message || "The image could not be validated.";
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

    // HPSubPick /boxes
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

    const form = new FormData();

    form.append("file", blob, name);
    form.append("printer_model", model);

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), CFG.TIMEOUT);

    let res;

    try {
        res = await fetch(CFG.API + CFG.DETECT, {
            method: "POST",
            body: form,
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

    const prediction = await res.json();
    return fromJson(prediction);
}


/* ========================================
   Run
   ======================================== */
$("go").onclick = async () => {
    if (working || !recognitionReady) return;
    $("msg").replaceChildren();
    $("results").hidden = true;

    if (!$("model").value) {
        $("merr").textContent =
            "Please choose an available recognition scope first.";

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

    S.parts.forEach(p => {
        const x = PARTS.find(y => y[0] === p.num);

        if (x) {
            p.desc = p.desc || x[2];
            p.mfg = x[1];
        }
    });

    // fill specs from the catalogue when the backend sends none
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

    // draw boxes ourselves when we have coordinates
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
    // click a box to select it; the smallest box under the cursor wins
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
    a.download = "kamero-results.zip";

    document.body.append(a);

    a.click();
    a.remove();

    step(5);
};

function makeZip(files) {
    // minimal uncompressed ZIP writer, no libraries needed
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
    validationRequest++;
    URL.revokeObjectURL($("pv").src);
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

        ["rec", "cat", "dataset", "his"].forEach(v => {
            $("v-" + v).hidden = v !== b.dataset.v;
        });

        if (b.dataset.v === "cat") renderCat();
        if (b.dataset.v === "his") renderHistory();
    };
});

function renderCat() {
    const q = $("q").value.trim().toLowerCase();
    const L = $("clist");

    const hit = PARTS.filter(
        x => !q || x.join(" ").toLowerCase().includes(q)
    );

    L.replaceChildren();

    hit.forEach(x => {
        const r = document.createElement("div");
        const b = document.createElement("b");
        const s = document.createElement("small");

        r.className = "crow";
        b.textContent = x[0];
        s.textContent = x[2] + (x[1] ? " · Mfg. " + x[1] : "");

        r.append(b, s);
        L.append(r);
    });

    $("cn").textContent =
        hit.length + " of " + PARTS.length + " parts";
}

$("q").oninput = renderCat;

const HK = "kamero.history.v1";

function hist() {
    try {
        return JSON.parse(localStorage.getItem(HK)) || [];
    } catch {
        return [];
    }
}

function saveHistory() {
    // thumbnail + results only, newest 20, stored in this browser
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

function feedbackUI(d, p) {
    // lets the user flag a wrong detection; the choice is included in the export for retraining review
    const w = document.createElement("div");
    const sel = document.createElement("select");
    const note = document.createElement("small");

    w.className = "fb";

    sel.append(
        new Option(
            "Flag as incorrect — choose the correct part…",
            ""
        )
    );

    PARTS.forEach(x => {
        sel.append(
            new Option(x[0] + " — " + x[2], x[0])
        );
    });

    sel.append(
        new Option("Not a printer part / unknown", "none")
    );

    sel.value = p.fb || "";

    note.textContent = p.fb
        ? "Saved in the export for review."
        : "";

    sel.onchange = () => {
        p.fb = sel.value || undefined;

        note.textContent = p.fb
            ? "Saved in the export for review."
            : "";
    };

    w.append(sel, note);
    d.append(w);
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
