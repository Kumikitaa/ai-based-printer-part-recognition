(() => {
    const el = (id) => document.getElementById(id);
    const state = {page: 1, pageSize: 20, total: 0, modelsLoaded: false };
    let controller;
    let timer;

    async function getJSON(url, signal) {
        const response = await fetch(url, { signal, cache: "no-store" });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(typeof body.detail === "string"
                ? body.detail : "Unable to load the catalogue. Please try again.");
        }
        return response.json();
    }

    function renderParts(parts) {
        const fragment = document.createDocumentFragment();
        if (!parts.length) {
            const empty = document.createElement("p");
            empty.className = "catalogue-empty";
            empty.textContent = el("q").value.trim() || el("catalogue-model").value
                ? "No matching parts. Try another search or clear the filters."
                : "No parts in the catalogue yet. Import your printer parts to get started.";
            fragment.append(empty);
        }
        for (const part of parts) {
            const card = document.createElement("article");
            card.className = "crow catalogue-part";

            const number = document.createElement("h3");
            number.textContent = part.serial_number;

            const description = document.createElement("p");
            description.textContent = part.part_desc;

            const models = document.createElement("div");
            models.className = "catalogue-models";
            models.setAttribute("aria-label", "Compatible printer models");

            for (const model of part.compatible_models) {
                const badge = document.createElement("span");
                badge.className = "catalogue-badge";
                badge.textContent = model.name;
                models.append(badge, " ");
            }

            if (!part.compatible_models.length) {
                models.textContent = "No printer compatibility recorded";
            }

            card.append(number, description, models);
            fragment.append(card);
        }
        el("clist").replaceChildren(fragment);
    }

    async function load() {
        clearTimeout(timer);
        controller?.abort();
        const request = new AbortController();
        controller = request;
        const timeout = setTimeout(() => request.abort(), 15000);

        el("clist").setAttribute("aria-busy", "true");
        el("clist").replaceChildren();
        el("cn").textContent = "Loading catalogue…";
        el("catalogue-error").hidden = true;
        el("catalogue-pagination").hidden = true;

        try {
            if (!state.modelsLoaded) {
                const models = await getJSON("/api/catalogue/models", request.signal);

                if (controller !== request) return;

                const select = el("catalogue-model");
                const selected = select.value;

                select.replaceChildren(new Option("All printer models", ""));
                for (const model of models) {
                    select.append(new Option(`${model.name} (${model.part_count})`, model.id));
                }
                select.value = selected;
                state.modelsLoaded = true;
            }
            const params = new URLSearchParams({q: el("q").value.trim(), page: state.page, page_size: state.pageSize});

            if (el("catalogue-model").value) params.set("model_id", el("catalogue-model").value);

            const data = await getJSON(`/api/catalogue/parts?${params}`, request.signal);
            if (controller !== request) return;

            state.total = data.total;
            if (state.page > 1 && !data.items.length) {
                state.page = Math.max(1, Math.ceil(data.total / state.pageSize));
                return load();
            }

            renderParts(data.items);
            const first = data.total ? (state.page - 1) * state.pageSize + 1 : 0;
            const last = first ? first + data.items.length - 1 : 0;
            el("cn").textContent = `${first}–${last} of ${data.total} parts`;
            const pages = Math.max(1, Math.ceil(data.total / state.pageSize));

            el("catalogue-page").textContent = `Page ${state.page} of ${pages}`;
            el("catalogue-prev").disabled = state.page === 1;
            el("catalogue-next").disabled = state.page >= pages;
            el("catalogue-pagination").hidden = pages <= 1;
        } catch (error) {
            if (controller !== request) return;

            state.modelsLoaded = false;
            el("cn").textContent = "Catalogue unavailable";
            el("catalogue-error-text").textContent = error.name === "AbortError"
                ? "The catalogue request timed out. Please try again."
                : error.message;
            el("catalogue-error").hidden = false;
        } finally {
            clearTimeout(timeout);
            if (controller === request) el("clist").setAttribute("aria-busy", "false");
        }
    }

    el("q").addEventListener("input", () => {
        state.page = 1;
        controller?.abort();
        controller = null;
        clearTimeout(timer);
        el("clist").replaceChildren();
        el("cn").textContent = "Searching...";
        el("catalogue-pagination").hidden = true;
        timer = setTimeout(load, 250);
    });

    el("catalogue-model").addEventListener("change", () => {
        state.page = 1;
        load();
    });

    el("catalogue-clear").addEventListener("click", () => {
        el("q").value = "";
        el("catalogue-model").value = "";
        state.page = 1;
        load();
    });

    el("catalogue-prev").addEventListener("click", () => { state.page--; load(); });
    el("catalogue-next").addEventListener("click", () => { state.page++; load(); });
    el("catalogue-retry").addEventListener("click", load);

    window.Catalogue = { load };
})();
