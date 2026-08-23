const params = new URLSearchParams(location.search);
const token = params.get("w") ?? "";
const mode = params.get("mode") === "detached" ? "detached" : "panel";

const els = {
    repository: document.getElementById("repository"),
    branch: document.getElementById("branch"),
    sync: document.getElementById("sync"),
    summary: document.getElementById("summary"),
    refresh: document.getElementById("refresh"),
    popout: document.getElementById("popout"),
    popin: document.getElementById("popin"),
    bringBack: document.getElementById("bring-back"),
    filter: document.getElementById("filter"),
    changes: document.getElementById("changes"),
    diffHeader: document.getElementById("diff-header"),
    diffTitle: document.getElementById("diff-title"),
    diffKind: document.getElementById("diff-kind"),
    diffTabs: document.getElementById("diff-tabs"),
    diff: document.getElementById("diff"),
    floatingOverlay: document.getElementById("floating-overlay"),
    errorOverlay: document.getElementById("error-overlay"),
    errorMessage: document.getElementById("error-message"),
    retry: document.getElementById("retry"),
};

const GROUPS = [
    ["conflicts", "Conflicts"],
    ["staged", "Staged changes"],
    ["working", "Changes"],
    ["untracked", "Untracked files"],
];
const KIND_LABELS = { conflict: "Conflict", staged: "Staged", working: "Working tree", untracked: "Untracked" };
const MAX_DIFF_LINES = 6000;

let state = null;
let selected = null;
let loading = false;
let diffRequest = 0;
let renderedDiff = { key: null, body: null };

function api(pathname, query = {}) {
    const url = new URL(pathname, location.origin);
    url.searchParams.set("w", token);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
}

async function request(pathname, options, query) {
    const response = await fetch(api(pathname, query), options);
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error?.message ?? `Request failed (${response.status})`);
    return body;
}

function statusLetter(entry) {
    if (entry.kind === "untracked") return "?";
    if (entry.kind === "conflict") return "!";
    return entry.kind === "staged" ? entry.xy[0] : entry.xy[1];
}

function fileParts(filePath) {
    const slash = filePath.lastIndexOf("/");
    return slash < 0 ? { base: filePath, dir: "" } : { base: filePath.slice(slash + 1), dir: filePath.slice(0, slash) };
}

function allEntries() {
    if (!state) return [];
    return GROUPS.flatMap(([key]) => state.groups[key]);
}

function availableKinds(filePath) {
    return allEntries()
        .filter((entry) => entry.path === filePath)
        .map((entry) => entry.kind);
}

function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function renderHeader() {
    els.repository.textContent = state.repository;
    els.branch.textContent = state.branch;
    const sync = [];
    if (state.ahead) sync.push(`↑${state.ahead}`);
    if (state.behind) sync.push(`↓${state.behind}`);
    els.sync.textContent = sync.join(" ");

    const totals = state.totals;
    els.summary.textContent = state.clean
        ? "No changes"
        : `${totals.files} file${totals.files === 1 ? "" : "s"}  +${totals.additions}  −${totals.deletions}`;
    document.title = `${state.repository} — Changes${mode === "detached" ? " (floating)" : ""}`;

    const showOverlay = mode === "panel" && state.detached;
    els.floatingOverlay.hidden = !showOverlay;
    els.popout.hidden = mode === "detached" || state.detached;
    els.popin.hidden = mode !== "detached";
}

function renderChanges() {
    const scrollTop = els.changes.scrollTop;
    els.changes.replaceChildren();
    const filter = els.filter.value.trim().toLowerCase();
    let visible = 0;

    for (const [key, label] of GROUPS) {
        const entries = state.groups[key].filter((entry) => !filter || entry.path.toLowerCase().includes(filter));
        if (entries.length === 0) continue;
        visible += entries.length;

        const group = make("section", "group");
        const title = make("div", "group-title");
        title.append(make("span", "", label), make("span", "count", String(entries.length)));
        group.append(title);

        for (const entry of entries) {
            const button = make("button", "file");
            button.type = "button";
            button.dataset.path = entry.path;
            button.dataset.kind = entry.kind;
            if (selected?.path === entry.path && selected?.kind === entry.kind) button.classList.add("selected");

            const letter = statusLetter(entry);
            const status = make("span", `status ${letter === "?" ? "status-question" : letter}`, letter);
            status.title = entry.status;

            const parts = fileParts(entry.path);
            const name = make("span", "file-name");
            name.append(make("div", "basename", parts.base));
            if (parts.dir) name.append(make("div", "dirname", parts.dir));

            const stats = make("span", "stats");
            if (typeof entry.additions === "number") stats.append(make("span", "add", `+${entry.additions}`));
            if (typeof entry.deletions === "number") stats.append(make("span", "del", `−${entry.deletions}`));
            button.append(status, name, stats);
            button.addEventListener("click", () => selectFile(entry.path, entry.kind));
            group.append(button);
        }
        els.changes.append(group);
    }

    if (visible === 0) {
        els.changes.append(make("div", "empty", state.clean ? "Working tree clean." : "No files match the filter."));
    }
    els.changes.scrollTop = scrollTop;
}

function lineClass(line) {
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return "meta";
    if (line.startsWith("+")) return "addition";
    if (line.startsWith("-")) return "deletion";
    return "";
}

function renderDiffBody(diff) {
    const scrollTop = els.diff.scrollTop;
    els.diff.replaceChildren();
    if (!diff.trim()) {
        els.diff.append(make("div", "placeholder", "No textual diff for this view."));
        return;
    }
    const lines = diff.split("\n");
    for (const line of lines.slice(0, MAX_DIFF_LINES)) {
        els.diff.append(make("div", `diff-line ${lineClass(line)}`, line || " "));
    }
    if (lines.length > MAX_DIFF_LINES) {
        els.diff.append(make("div", "placeholder", `Diff truncated after ${MAX_DIFF_LINES.toLocaleString()} lines.`));
    }
    els.diff.scrollTop = scrollTop;
}

function renderDiffTabs() {
    els.diffTabs.replaceChildren();
    for (const kind of availableKinds(selected.path)) {
        const button = make("button", `diff-tab${kind === selected.kind ? " active" : ""}`, KIND_LABELS[kind]);
        button.type = "button";
        button.addEventListener("click", () => selectFile(selected.path, kind));
        els.diffTabs.append(button);
    }
}

async function loadDiff({ background = false } = {}) {
    if (!selected) {
        els.diffHeader.hidden = true;
        els.diff.replaceChildren(make("div", "placeholder", "Select a changed file to view its diff."));
        renderedDiff = { key: null, body: null };
        return;
    }
    const requestId = ++diffRequest;
    const key = `${selected.kind}\0${selected.path}`;
    els.diffHeader.hidden = false;
    els.diffTitle.textContent = selected.path;
    els.diffKind.textContent = KIND_LABELS[selected.kind];
    renderDiffTabs();
    if (!background) els.diff.replaceChildren(make("div", "placeholder", "Loading diff…"));

    try {
        const result = await request("/api/diff", undefined, selected);
        if (requestId !== diffRequest) return;
        if (renderedDiff.key === key && renderedDiff.body === result.diff) return;
        renderDiffBody(result.diff);
        renderedDiff = { key, body: result.diff };
    } catch (error) {
        if (!background && requestId === diffRequest) {
            els.diff.replaceChildren(make("div", "placeholder", error.message));
            renderedDiff = { key: null, body: null };
        }
    }
}

function selectFile(filePath, kind) {
    selected = { path: filePath, kind };
    renderChanges();
    void loadDiff({ background: false });
}

function ensureSelection() {
    if (selected && allEntries().some((entry) => entry.path === selected.path && entry.kind === selected.kind)) return false;
    const first = allEntries()[0];
    selected = first ? { path: first.path, kind: first.kind } : null;
    return true;
}

function showError(error) {
    els.errorMessage.textContent = String(error.message ?? error);
    els.errorOverlay.hidden = false;
}

async function refresh({ forceDiff = false, background = false } = {}) {
    if (loading || !token) return;
    loading = true;
    els.refresh.disabled = true;
    try {
        state = await request("/api/state");
        els.errorOverlay.hidden = true;
        const selectionChanged = ensureSelection();
        renderHeader();
        renderChanges();
        if (forceDiff || selectionChanged) await loadDiff({ background: false });
        else if (selected) await loadDiff({ background: true });
    } catch (error) {
        showError(error);
    } finally {
        loading = false;
        els.refresh.disabled = false;
    }
}

async function post(pathname) {
    try {
        await request(pathname, { method: "POST" });
        await refresh({ forceDiff: false, background: false });
    } catch (error) {
        showError(error);
    }
}

els.refresh.addEventListener("click", () => refresh({ forceDiff: true }));
els.retry.addEventListener("click", () => refresh({ forceDiff: true }));
els.filter.addEventListener("input", renderChanges);
els.popout.addEventListener("click", () => post("/api/detach"));
els.bringBack.addEventListener("click", () => post("/api/attach"));
els.popin.addEventListener("click", async () => {
    await post("/api/attach");
    window.close();
});

if (!token) showError(new Error("Missing workspace token."));
else {
    void refresh({ forceDiff: true });
    setInterval(() => {
        if (document.visibilityState === "visible") void refresh({ background: true });
    }, 2500);
}
