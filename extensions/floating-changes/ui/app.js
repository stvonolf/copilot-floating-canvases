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
    gitMode: document.getElementById("git-mode"),
    reviewMode: document.getElementById("review-mode"),
    reviewControls: document.getElementById("review-controls"),
    checkpoint: document.getElementById("review-checkpoint"),
    reviewIntro: document.getElementById("review-intro"),
    markReviewed: document.getElementById("mark-reviewed"),
    reviewLoading: document.getElementById("review-loading"),
    reviewMessage: document.getElementById("review-message"),
    reviewFeedback: document.getElementById("review-feedback"),
    feedbackFile: document.getElementById("feedback-file"),
    feedbackAll: document.getElementById("feedback-all"),
    feedbackForm: document.getElementById("feedback-form"),
    feedbackPath: document.getElementById("feedback-path"),
    feedbackText: document.getElementById("feedback-text"),
    feedbackHint: document.getElementById("feedback-hint"),
    feedbackSubmit: document.getElementById("feedback-submit"),
    feedbackList: document.getElementById("feedback-list"),
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
let loadingInBackground = false;
let diffRequest = 0;
let renderedDiff = { key: null, body: null };
let activeView = "git";
let reviewState = null;
let reviewSelected = null;
let reviewShown = null;
let reviewLoading = false;
let reviewLoadingInBackground = false;
let reviewUpdating = false;
let reviewSelecting = false;
let reviewMutation = false;
let reviewStale = false;
let reviewNeedsRefresh = false;
let reviewRequest = 0;
let feedbackScope = "file";
let feedbackDraftPath = null;
let feedbackListKey = null;
let reviewFilesKey = null;
const feedbackDrafts = new Map();

function api(pathname, query = {}) {
    const url = new URL(pathname, location.origin);
    url.searchParams.set("w", token);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
}

async function request(pathname, options, query) {
    const init = { ...options };
    if (init.method === "POST") {
        init.headers = { ...init.headers, "Content-Type": "application/json", "X-Review-Token": token };
    }
    const response = await fetch(api(pathname, query), init);
    let body;
    try {
        body = await response.json();
    } catch {
        throw new Error(`The server returned an unreadable response (${response.status}). Refresh to retry.`);
    }
    if (!response.ok || body.error) {
        const error = new Error(body.error?.message ?? `Request failed (${response.status})`);
        error.code = body.error?.code;
        error.status = response.status;
        throw error;
    }
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
    if (activeView === "review") renderReviewHeader();
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
    const scrollLeft = els.diff.scrollLeft;
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
    els.diff.scrollLeft = scrollLeft;
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
    if (activeView !== "git") return;
    const requestId = ++diffRequest;
    if (!selected) {
        els.diffHeader.hidden = true;
        els.diff.replaceChildren(make("div", "placeholder", "Select a changed file to view its diff."));
        renderedDiff = { key: null, body: null };
        return;
    }
    const key = `${selected.kind}\0${selected.path}`;
    els.diffHeader.hidden = false;
    els.diffTitle.textContent = selected.path;
    els.diffKind.textContent = KIND_LABELS[selected.kind];
    els.diffTabs.hidden = false;
    renderDiffTabs();
    if (!background) els.diff.replaceChildren(make("div", "placeholder", "Loading diff…"));

    try {
        const result = await request("/api/diff", undefined, selected);
        if (requestId !== diffRequest || activeView !== "git") return;
        if (background && renderedDiff.key === key && renderedDiff.body === result.diff) return;
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
    loadingInBackground = background;
    els.refresh.disabled = true;
    updateReviewControls();
    try {
        state = await request("/api/state");
        els.errorOverlay.hidden = true;
        const selectionChanged = ensureSelection();
        renderHeader();
        if (activeView === "git") {
            renderChanges();
            if (forceDiff || selectionChanged) await loadDiff({ background: false });
            else if (selected) await loadDiff({ background: true });
        }
    } catch (error) {
        if (activeView === "review") setReviewMessage(`Could not refresh window status: ${error.message}`, true);
        else showError(error);
    } finally {
        loading = false;
        loadingInBackground = false;
        updateReviewControls();
    }
    if (activeView === "review") await refreshReview({ background });
}

async function post(pathname, query) {
    try {
        await request(pathname, { method: "POST" }, query);
        await refresh({ forceDiff: false, background: false });
    } catch (error) {
        showError(error);
    }
}

function formatTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
}

function setReviewMessage(message, error = false) {
    els.reviewMessage.textContent = message;
    els.reviewMessage.hidden = !message;
    els.reviewMessage.classList.toggle("error", error);
    els.reviewMessage.setAttribute("role", error ? "alert" : "status");
}

function reviewEntry(filePath = reviewSelected) {
    return reviewState?.files.find((entry) => entry.path === filePath);
}

function reviewIsReady() {
    // Background reads may use the rendered snapshot; writes invalidate those reads and the server guards staleness.
    return activeView === "review" && reviewState && reviewShown
        && reviewShown.viewId === reviewState.viewId && reviewShown.path === reviewSelected
        && (!loading || loadingInBackground) && (!reviewLoading || reviewLoadingInBackground)
        && !reviewUpdating && !reviewSelecting && !reviewMutation && !reviewStale && !reviewNeedsRefresh;
}

function updateReviewControls() {
    els.refresh.disabled = loading || reviewLoading || reviewSelecting || reviewMutation;
    const ready = Boolean(reviewIsReady());
    els.markReviewed.disabled = !ready;
    els.markReviewed.dataset.viewId = reviewState?.viewId ?? "";
    els.markReviewed.title = "Mark the entire tracked and nonignored working tree reviewed, including filtered-out files. Does not resolve feedback.";
    const hasFile = Boolean(reviewEntry());
    els.feedbackText.disabled = !hasFile;
    els.feedbackSubmit.disabled = !ready || !hasFile || !els.feedbackText.value.trim();
    els.feedbackHint.textContent = !hasFile
        ? "Select a changed file to add feedback."
        : `${els.feedbackText.value.length.toLocaleString()}/2,000 · Saved with this file view.`;
    const busy = (reviewLoading && !reviewLoadingInBackground) || reviewUpdating || reviewSelecting || reviewMutation;
    els.reviewLoading.hidden = !busy;
    els.reviewLoading.textContent = reviewMutation ? "Saving…" : "Refreshing review snapshot…";
    els.reviewControls.setAttribute("aria-busy", String(busy));
    const disableSelection = reviewMutation || reviewStale || reviewNeedsRefresh;
    for (const button of els.changes.querySelectorAll(".review-file")) button.disabled = disableSelection;
    for (const button of els.feedbackList.querySelectorAll("[data-feedback-id]")) button.disabled = !ready;
    for (const button of els.feedbackList.querySelectorAll(".feedback-path-button")) button.disabled = disableSelection;
}

function renderReviewHeader() {
    const checkpoint = reviewState?.checkpoint;
    els.checkpoint.textContent = !reviewState ? "Loading baseline…" : checkpoint ? formatTimestamp(checkpoint.at) : "No baseline yet";
    if (checkpoint) els.checkpoint.dateTime = checkpoint.at;
    else els.checkpoint.removeAttribute("datetime");
    els.checkpoint.title = checkpoint ? `${checkpoint.at} · ${checkpoint.files} files reviewed` : "";
    els.reviewIntro.hidden = !reviewState || Boolean(checkpoint);
    els.markReviewed.textContent = reviewState && !checkpoint ? "Start tracking" : "Mark all reviewed";
    const counts = reviewState?.counts;
    els.summary.textContent = !reviewState ? "Loading review…"
        : !checkpoint ? "Not tracking yet"
            : !counts.files ? "No new changes"
                : `${counts.files} file${counts.files === 1 ? "" : "s"}  +${counts.additions}  −${counts.deletions}`;
    document.title = `${state?.repository ?? "Changes"} — Since you looked${mode === "detached" ? " (floating)" : ""}`;
    document.body.classList.toggle("review-empty", Boolean(reviewState && !reviewState.files.length));
}

function renderReviewFiles() {
    if (activeView !== "review") return;
    const filter = els.filter.value.trim().toLowerCase();
    const key = JSON.stringify([reviewState?.files, reviewState?.feedback, reviewSelected, filter]);
    if (key === reviewFilesKey) return;
    reviewFilesKey = key;
    const scrollTop = els.changes.scrollTop;
    els.changes.replaceChildren();
    if (!reviewState) {
        els.changes.append(make("div", "empty", "Loading review snapshot…"));
        return;
    }
    const files = reviewState.files.filter((entry) => !filter
        || entry.path.toLowerCase().includes(filter) || entry.oldPath?.toLowerCase().includes(filter));
    if (!files.length) {
        const text = reviewState.files.length ? "No files match the filter."
            : reviewState.checkpoint ? "No changes since your reviewed baseline." : "Start tracking after reviewing Git changes.";
        els.changes.append(make("div", "empty", text));
    } else {
        const group = make("section", "group");
        const title = make("div", "group-title");
        title.append(make("span", "", "Since reviewed"), make("span", "count", String(files.length)));
        group.append(title);
        for (const entry of files) {
            const button = make("button", `file review-file${entry.path === reviewSelected ? " selected" : ""}`);
            button.type = "button";
            button.dataset.path = entry.path;
            button.dataset.kind = "review";
            button.title = entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path;
            button.setAttribute("aria-pressed", String(entry.path === reviewSelected));
            const letter = { Added: "A", Modified: "M", Deleted: "D", Renamed: "R", "Type changed": "T" }[entry.status] ?? "M";
            const status = make("span", `status ${letter}`, letter);
            status.title = entry.status;
            const parts = fileParts(entry.path);
            const name = make("span", "file-name");
            name.append(make("div", "basename", parts.base));
            if (parts.dir) name.append(make("div", "dirname", parts.dir));
            const stats = make("span", "stats");
            if (entry.binary) stats.append(make("span", "dirname", "Binary"));
            else {
                if (typeof entry.additions === "number") stats.append(make("span", "add", `+${entry.additions}`));
                if (typeof entry.deletions === "number") stats.append(make("span", "del", `−${entry.deletions}`));
            }
            const openNotes = reviewState.feedback.filter((note) => note.path === entry.path && note.status === "open").length;
            if (openNotes) {
                const badge = make("span", "count", String(openNotes));
                badge.title = `${openNotes} open feedback note${openNotes === 1 ? "" : "s"}`;
                stats.append(badge);
            }
            button.append(status, name, stats);
            button.addEventListener("click", () => void selectReviewFile(entry.path));
            group.append(button);
        }
        els.changes.append(group);
    }
    els.changes.scrollTop = scrollTop;
    updateReviewControls();
}

function saveFeedbackDraft() {
    if (feedbackDraftPath) feedbackDrafts.set(feedbackDraftPath, els.feedbackText.value);
}

function renderFeedback() {
    if (feedbackDraftPath !== reviewSelected) {
        saveFeedbackDraft();
        feedbackDraftPath = reviewSelected;
        els.feedbackText.value = feedbackDrafts.get(reviewSelected) ?? "";
    }
    els.feedbackPath.textContent = reviewSelected ?? "";
    els.feedbackPath.title = reviewSelected ?? "";
    els.feedbackFile.disabled = !reviewSelected;
    els.feedbackFile.classList.toggle("active", feedbackScope === "file");
    els.feedbackAll.classList.toggle("active", feedbackScope === "all");
    els.feedbackFile.setAttribute("aria-pressed", String(feedbackScope === "file"));
    els.feedbackAll.setAttribute("aria-pressed", String(feedbackScope === "all"));
    const feedback = reviewState?.feedback ?? [];
    els.feedbackAll.title = `${feedback.filter((note) => note.status === "open").length} open · ${feedback.filter((note) => note.status === "resolved").length} resolved`;
    const notes = feedbackScope === "all" ? feedback : feedback.filter((note) => note.path === reviewSelected);
    const key = JSON.stringify([feedbackScope, reviewSelected, notes]);
    if (key !== feedbackListKey) {
        feedbackListKey = key;
        const scrollTop = els.feedbackList.scrollTop;
        els.feedbackList.replaceChildren();
        if (!notes.length) {
            els.feedbackList.append(make("div", "empty", feedbackScope === "all"
                ? "No feedback yet. Saved notes stay here across reviewed baselines."
                : "No feedback for this file. Notes stay open until explicitly resolved."));
        }
        for (const status of ["open", "resolved"]) {
            const entries = notes.filter((note) => note.status === status);
            if (!entries.length) continue;
            const group = make("section", "feedback-group");
            group.append(make("h3", "feedback-group-title", `${status === "open" ? "Open" : "Resolved"} (${entries.length})`));
            for (const note of entries) {
                const item = make("article", "feedback-item");
                item.dataset.noteId = note.id;
                item.dataset.status = note.status;
                const path = make("button", "feedback-path-button", note.path);
                path.type = "button";
                path.addEventListener("click", () => void selectReviewFile(note.path));
                item.append(path, make("p", "feedback-note", note.text));
                if (note.changedSinceComment) item.append(make("p", "feedback-advisory", "File changed since comment"));
                const footer = make("div", "feedback-item-footer");
                const at = status === "resolved" && note.resolvedAt ? note.resolvedAt : note.createdAt;
                const time = make("time", "feedback-meta", `${status === "resolved" ? "Resolved" : "Added"} ${formatTimestamp(at)}`);
                time.dateTime = at;
                time.title = `Created ${note.createdAt}${note.resolvedAt ? ` · Resolved ${note.resolvedAt}` : ""}`;
                const button = make("button", "button", status === "open" ? "Resolve" : "Reopen");
                button.type = "button";
                button.dataset.feedbackId = note.id;
                button.dataset.status = status === "open" ? "resolved" : "open";
                button.addEventListener("click", () => void writeReview("/api/review/feedback/status", {
                    id: note.id, status: button.dataset.status, feedbackVersion: reviewState.feedbackVersion,
                }, status === "open" ? "Feedback resolved." : "Feedback reopened."));
                footer.append(time, button);
                item.append(footer);
                group.append(item);
            }
            els.feedbackList.append(group);
        }
        els.feedbackList.scrollTop = scrollTop;
    }
    updateReviewControls();
}

function chooseReviewSelection(next) {
    if (reviewSelected && (next.files.some((entry) => entry.path === reviewSelected)
        || next.feedback.some((note) => note.path === reviewSelected))) return reviewSelected;
    return next.files[0]?.path ?? null;
}

async function fetchReviewDiff(next, filePath) {
    if (reviewShown?.viewId === next.viewId && reviewShown.path === filePath) return reviewShown;
    const entry = next.files.find((file) => file.path === filePath);
    if (!entry) return { viewId: next.viewId, path: filePath, diff: null, binary: false };
    const result = await request("/api/review/diff", undefined, { path: filePath, viewId: next.viewId });
    return { ...result, viewId: next.viewId, path: filePath };
}

function renderReviewDiff(shown) {
    els.diffTabs.hidden = true;
    els.diffHeader.hidden = !shown.path;
    els.diffTitle.textContent = shown.path ?? "";
    els.diffTitle.title = shown.path ?? "";
    const entry = reviewEntry(shown.path);
    els.diffKind.textContent = entry ? `${entry.status} · Since reviewed` : "No delta · Saved feedback";
    if (shown.diff !== null && shown.path === reviewShown?.path
        && shown.diff === reviewShown.diff && shown.binary === reviewShown.binary) return;
    if (shown.path !== reviewShown?.path) {
        els.diff.scrollTop = 0;
        els.diff.scrollLeft = 0;
    }
    if (shown.diff === null) {
        const text = !reviewState.checkpoint
            ? "No reviewed baseline yet. Review Git changes, then choose Start tracking. Nothing is marked automatically."
            : shown.path ? "No delta is listed for this file. Its feedback remains available until you explicitly resolve it."
                : "No changes since your reviewed baseline. All feedback is still available.";
        els.diff.replaceChildren(make("div", "placeholder", text));
    } else if (shown.binary && !shown.diff.trim()) {
        els.diff.replaceChildren(make("div", "placeholder", "Binary file changed. No textual diff is available."));
    } else renderDiffBody(shown.diff);
}

function commitReviewSnapshot(next, filePath, shown) {
    // A fetched state becomes actionable only when its matching immutable diff is ready to render.
    reviewState = next;
    reviewSelected = filePath;
    reviewStale = false;
    reviewNeedsRefresh = false;
    if (!reviewSelected) feedbackScope = "all";
    renderReviewHeader();
    renderReviewFiles();
    renderReviewDiff(shown);
    reviewShown = shown;
    document.body.dataset.reviewViewId = next.viewId;
    renderFeedback();
}

function showReviewFailure(error, prefix = "") {
    reviewStale = true;
    reviewShown = null;
    if (!reviewState) els.checkpoint.textContent = "Baseline unavailable";
    if (error.status === 409) reviewNeedsRefresh = true;
    const detail = error.status === 409
        ? error.code === "stale_view"
            ? "This review snapshot is out of date. Refresh, review the new changes, then try again."
            : "Feedback changed in another window. Refresh to see the latest notes, then try again."
        : `${error.message}${error.code ? ` (${error.code})` : ""}`;
    setReviewMessage(`${prefix}${detail}`, true);
    els.diff.replaceChildren(make("div", "placeholder", "Review snapshot unavailable. Refresh to load a current view."));
    updateReviewControls();
}

async function refreshReview({ background = false } = {}) {
    if (activeView !== "review" || reviewLoading || reviewSelecting || reviewMutation || !token) return;
    if (background && reviewNeedsRefresh) return;
    reviewLoading = true;
    reviewLoadingInBackground = background;
    const requestId = ++reviewRequest;
    const wasStale = reviewStale || reviewNeedsRefresh;
    updateReviewControls();
    try {
        const next = await request("/api/review/state");
        if (requestId !== reviewRequest || activeView !== "review") return;
        const filePath = chooseReviewSelection(next);
        reviewUpdating = next.viewId !== reviewState?.viewId || filePath !== reviewSelected;
        updateReviewControls();
        const shown = await fetchReviewDiff(next, filePath);
        if (requestId !== reviewRequest || activeView !== "review") return;
        commitReviewSnapshot(next, filePath, shown);
        if (wasStale) setReviewMessage("Snapshot refreshed. Review the changes before marking all reviewed.");
        else if (!background) setReviewMessage("");
    } catch (error) {
        if (requestId === reviewRequest && activeView === "review") showReviewFailure(error);
    } finally {
        reviewLoading = false;
        reviewLoadingInBackground = false;
        reviewUpdating = false;
        updateReviewControls();
    }
}

async function selectReviewFile(filePath) {
    if (activeView !== "review" || !reviewState || reviewMutation || reviewStale || reviewNeedsRefresh) return;
    if (filePath === reviewSelected && reviewShown?.path === filePath) {
        feedbackScope = "file";
        renderFeedback();
        return;
    }
    const requestId = ++reviewRequest;
    reviewSelecting = true;
    reviewSelected = filePath;
    feedbackScope = "file";
    renderReviewFiles();
    renderFeedback();
    els.diffHeader.hidden = false;
    els.diffTitle.textContent = filePath;
    els.diffKind.textContent = "Loading review diff…";
    els.diff.replaceChildren(make("div", "placeholder", "Loading diff…"));
    reviewShown = null;
    updateReviewControls();
    try {
        const shown = await fetchReviewDiff(reviewState, filePath);
        if (requestId !== reviewRequest || activeView !== "review") return;
        renderReviewDiff(shown);
        reviewShown = shown;
    } catch (error) {
        if (requestId === reviewRequest && activeView === "review") showReviewFailure(error);
    } finally {
        if (requestId === reviewRequest) reviewSelecting = false;
        updateReviewControls();
    }
}

async function writeReview(pathname, payload, successMessage, onSaved) {
    if (!reviewIsReady()) return;
    reviewMutation = true;
    const requestId = ++reviewRequest;
    let saved = false;
    setReviewMessage("");
    updateReviewControls();
    try {
        const next = await request(pathname, { method: "POST", body: JSON.stringify(payload) });
        saved = true;
        onSaved?.();
        if (requestId !== reviewRequest || activeView !== "review") return;
        const filePath = chooseReviewSelection(next);
        const shown = await fetchReviewDiff(next, filePath);
        if (requestId !== reviewRequest || activeView !== "review") return;
        commitReviewSnapshot(next, filePath, shown);
        setReviewMessage(successMessage);
    } catch (error) {
        if (activeView === "review") {
            const prefix = saved ? `${successMessage} The updated snapshot could not be loaded. `
                : error.status === 409
                    ? pathname.endsWith("/checkpoint") ? "Nothing was marked reviewed. " : "Feedback was not changed. "
                    : "Update not confirmed. Refresh to check the saved state before trying again. ";
            showReviewFailure(error, prefix);
        }
    } finally {
        reviewMutation = false;
        updateReviewControls();
        if (requestId !== reviewRequest && activeView === "review") void refreshReview();
    }
}

function setView(view) {
    if (activeView === view) return;
    saveFeedbackDraft();
    activeView = view;
    ++diffRequest;
    ++reviewRequest;
    reviewSelecting = false;
    reviewShown = null;
    reviewFilesKey = null;
    renderedDiff = { key: null, body: null };
    document.body.classList.toggle("review-mode", view === "review");
    document.body.classList.remove("review-empty");
    document.body.dataset.view = view;
    els.gitMode.classList.toggle("active", view === "git");
    els.reviewMode.classList.toggle("active", view === "review");
    els.gitMode.setAttribute("aria-pressed", String(view === "git"));
    els.reviewMode.setAttribute("aria-pressed", String(view === "review"));
    els.reviewControls.hidden = view !== "review";
    els.reviewFeedback.hidden = view !== "review";
    els.diffHeader.hidden = true;
    els.diffTabs.hidden = view === "review";
    els.diff.scrollTop = 0;
    els.diff.scrollLeft = 0;
    els.diff.replaceChildren(make("div", "placeholder", "Loading changes…"));
    if (state) renderHeader();
    if (view === "git") {
        if (state) {
            renderChanges();
            void loadDiff();
        } else void refresh({ forceDiff: true });
    } else {
        els.errorOverlay.hidden = true;
        renderReviewHeader();
        renderReviewFiles();
        renderFeedback();
        void refreshReview();
    }
    updateReviewControls();
}

els.gitMode.addEventListener("click", () => setView("git"));
els.reviewMode.addEventListener("click", () => setView("review"));
els.markReviewed.addEventListener("click", () => {
    if (!reviewIsReady()) return;
    void writeReview("/api/review/checkpoint", { viewId: reviewState.viewId },
        "All tracked and nonignored files marked reviewed, including filtered-out files. Feedback was not resolved.");
});
els.feedbackFile.addEventListener("click", () => {
    if (!reviewSelected) return;
    feedbackScope = "file";
    renderFeedback();
});
els.feedbackAll.addEventListener("click", () => {
    feedbackScope = "all";
    renderFeedback();
});
els.feedbackText.addEventListener("input", () => {
    saveFeedbackDraft();
    updateReviewControls();
});
els.feedbackForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!reviewIsReady() || !reviewEntry() || !els.feedbackText.value.trim()) return;
    const path = reviewSelected;
    const text = els.feedbackText.value;
    void writeReview("/api/review/feedback", { viewId: reviewState.viewId, path, text }, "Feedback saved.", () => {
        if (feedbackDrafts.get(path) === text) feedbackDrafts.delete(path);
        if (feedbackDraftPath === path && els.feedbackText.value === text) els.feedbackText.value = "";
    });
});

els.refresh.addEventListener("click", () => refresh({ forceDiff: true }));
els.retry.addEventListener("click", () => refresh({ forceDiff: true }));
els.filter.addEventListener("input", () => {
    if (activeView === "review") renderReviewFiles();
    else if (state) renderChanges();
});
els.popout.addEventListener("click", () => post("/api/detach", { view: activeView }));
els.bringBack.addEventListener("click", () => post("/api/attach"));
els.popin.addEventListener("click", async () => {
    await post("/api/attach");
    window.close();
});

if (!token) showError(new Error("Missing workspace token."));
else {
    if (params.get("view") === "review") setView("review");
    void refresh({ forceDiff: true });
    setInterval(() => {
        if (document.visibilityState === "visible") void refresh({ background: true });
    }, 2500);
}
