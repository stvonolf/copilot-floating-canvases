const $ = (selector) => document.querySelector(selector);
const root = document.documentElement;
const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
const validToken = /^[a-f0-9]{64}$/i.test(token);
const revisionIdPattern = /^[a-f0-9]{40}$/i;
const themeChoices = ["light", "dark", "system"];
const osTheme = matchMedia("(prefers-color-scheme: dark)");
const surfaceParams = new URLSearchParams(location.search);
const isFloating = surfaceParams.get("surface") === "floating";
const windowId = surfaceParams.get("window");
root.dataset.surface = isFloating ? "floating" : "panel";

let theme = "system";
let state = null;
let readError = null;
let captureError = null;
let historyError = null;
let selectedId = null;
let followLatest = true;
let view = "diff";
let showContext = false;
let entries = [];
let nextCursor = null;
const entryById = new Map();
const pageCursors = new Map();
let revision = null;
let revisionKey = null;
let revisionError = null;
let revisionLoadingKey = null;
let revisionGeneration = 0;
let revisionController = null;
let renderedDocumentKey = null;
let stateRequest = null;
let historyRequest = null;
let capturing = false;
let pollTimer = null;
let disposed = false;
let requestQueue = Promise.resolve();
let activeRequestController = null;
let floatingState = null;
let windowError = null;
let movingWindow = false;
let windowInitialized = false;
let transferredTheme = null;
let restoreScroll = null;
let publishTimer = null;
let publishedView = null;

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setExpanded(trigger, target, expanded) {
  $(trigger).setAttribute("aria-expanded", String(expanded));
  $(target).hidden = !expanded;
}

function showStorageWarning(message) {
  $("#storage-warning").textContent = message;
  $("#storage-warning").hidden = false;
}

function saveThemePreference() {
  try {
    localStorage.setItem("plan-time-machine-theme", theme);
    $("#storage-warning").hidden = true;
  } catch {
    showStorageWarning("Appearance changed for this tab, but this browser cannot save the preference.");
  }
}

try {
  const saved = localStorage.getItem("plan-time-machine-theme");
  if (themeChoices.includes(saved)) theme = saved;
} catch {
  showStorageWarning("Saved appearance preferences are unavailable. Appearance follows the app or your system.");
}

function nativeTheme() {
  for (const attribute of ["data-color-mode", "data-theme-tone"]) {
    for (const element of [document.body, root]) {
      const value = element.getAttribute(attribute)?.toLowerCase();
      if (value === "light" || value === "dark") return value;
    }
  }
  const background = getComputedStyle(document.body).getPropertyValue("--background-color-default").trim();
  if (!background) return null;
  const probe = make("span");
  probe.hidden = true;
  probe.style.color = background;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const channels = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (!channels) return null;
  const brightness = Number(channels[1]) * .2126 + Number(channels[2]) * .7152 + Number(channels[3]) * .0722;
  return brightness < 140 ? "dark" : "light";
}

function applyTheme() {
  const appTheme = nativeTheme();
  root.dataset.appearance = theme;
  root.dataset.appTheme = String(appTheme !== null);
  root.dataset.resolvedTheme = theme === "system" ? appTheme ?? (isFloating ? transferredTheme : null) ?? (osTheme.matches ? "dark" : "light") : theme;
  const name = theme[0].toUpperCase() + theme.slice(1);
  $("#theme-trigger").setAttribute("aria-label", `Appearance: ${name}`);
  $("#theme-trigger").title = `Appearance: ${name}`;
  document.querySelectorAll("[data-theme-option]").forEach((button) => {
    const active = button.dataset.themeOption === theme;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

applyTheme();
osTheme.addEventListener("change", applyTheme);
const themeObserver = new MutationObserver(applyTheme);
// Observe only host-owned attributes, never the appearance attributes written above.
for (const element of [root, document.body]) {
  themeObserver.observe(element, { attributes: true, attributeFilter: ["data-color-mode", "data-theme-tone", "style", "class"] });
}
themeObserver.observe(document.head, { childList: true, subtree: true, characterData: true });

$("#theme-trigger").addEventListener("click", () => {
  const opening = $("#theme-options").hidden;
  setExpanded("#theme-trigger", "#theme-options", opening);
  if (opening) $(`[data-theme-option="${theme}"]`).focus();
});
document.querySelectorAll("[data-theme-option]").forEach((button) => button.addEventListener("click", () => {
  theme = button.dataset.themeOption;
  applyTheme();
  saveThemePreference();
  setExpanded("#theme-trigger", "#theme-options", false);
  $("#theme-trigger").focus();
  scheduleViewPublish();
}));
document.addEventListener("click", (event) => {
  if (!event.target.closest(".settings")) setExpanded("#theme-trigger", "#theme-options", false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!$("#theme-options").hidden) {
      setExpanded("#theme-trigger", "#theme-options", false);
      $("#theme-trigger").focus();
    } else if (!$("#history").hidden) {
      setExpanded("#history-trigger", "#history", false);
      $("#history-trigger").focus();
    }
  }
  if (!$("#theme-options").hidden && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    const buttons = [...document.querySelectorAll("[data-theme-option]")];
    const index = buttons.indexOf(document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }
});

function apiError(message, code = "REQUEST_FAILED", status = null) {
  return Object.assign(new Error(message), { code, status });
}

function request(path, { method = "GET", signal, body: requestBody } = {}) {
  // Serialize polling, navigation, pagination, and capture so responses cannot overtake each other.
  const operation = requestQueue.then(async () => {
    if (disposed || signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    if (!validToken) throw apiError("Reopen Plan Time Machine from Copilot to get a valid panel link.", "INVALID_TOKEN");
    const controller = new AbortController();
    activeRequestController = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 15000);
    try {
      const response = await fetch(path, {
        method,
        headers: { "X-Plan-Token": token, Accept: "application/json", ...(requestBody === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
        cache: "no-store",
        credentials: "omit",
        mode: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      let body;
      try {
        body = await response.json();
      } catch {
        throw apiError("The local history service returned an unreadable response.", "INVALID_RESPONSE", response.status);
      }
      if (!response.ok) {
        throw apiError(body?.error?.message ?? `The local history request failed (${response.status}).`,
          body?.error?.code ?? "REQUEST_FAILED", response.status);
      }
      return body;
    } catch (error) {
      if (signal?.aborted || disposed) throw new DOMException("Request cancelled", "AbortError");
      if (error.name === "AbortError") throw apiError("The local history service took too long to respond. Try refreshing.", "TIMEOUT");
      if (error instanceof TypeError) throw apiError("Cannot connect to local plan history. Keep the Copilot session open, then retry.", "CONNECTION_FAILED");
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (activeRequestController === controller) activeRequestController = null;
    }
  });
  requestQueue = operation.catch(() => {});
  return operation;
}

function validateHistory(page) {
  if (!page || !Array.isArray(page.entries)
    || !(page.nextCursor === null || revisionIdPattern.test(page.nextCursor))
    || page.entries.some((entry) => !entry || !revisionIdPattern.test(entry.id)
      || typeof entry.title !== "string" || typeof entry.createdAt !== "string"
      || !(entry.parent === null || revisionIdPattern.test(entry.parent)))) {
    throw apiError("The local history service returned invalid revision metadata.", "INVALID_RESPONSE");
  }
  return page;
}

function validateState(value) {
  if (!value || !["waiting", "ready", "missing", "error"].includes(value.status)
    || typeof value.version !== "string" || typeof value.working !== "boolean"
    || typeof value.current?.exists !== "boolean" || !value.capture
    || !(value.head === null || revisionIdPattern.test(value.head))) {
    throw apiError("The local history service returned invalid plan state.", "INVALID_RESPONSE");
  }
  validateHistory(value.history);
  return value;
}

function validateRevision(value, id) {
  if (!value || value.id !== id || typeof value.content !== "string"
    || typeof value.exists !== "boolean" || typeof value.isWorking !== "boolean"
    || !Array.isArray(value.diff?.lines)
    || !Number.isFinite(value.diff.added) || !Number.isFinite(value.diff.removed)
    || value.diff.lines.some((line) => !line || !["context", "add", "remove", "hunk", "notice"].includes(line.type)
      || typeof line.text !== "string")) {
    throw apiError(value?.error?.message ?? "The local history service returned an invalid revision.",
      value?.error?.code ?? "INVALID_RESPONSE");
  }
  return value;
}

function currentView() {
  return {
    selectedId, followLatest, view, showContext, theme,
    resolvedTheme: root.dataset.resolvedTheme || "light",
    scrollY: Math.min(10000000, Math.max(0, window.scrollY)),
    historyOpen: !$("#history").hidden,
  };
}

function restoreView(value) {
  if (!value) return;
  selectedId = value.selectedId;
  followLatest = value.followLatest;
  view = value.view;
  showContext = value.showContext;
  theme = value.theme;
  transferredTheme = value.resolvedTheme;
  restoreScroll = value.scrollY;
  setExpanded("#history-trigger", "#history", value.historyOpen);
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderedDocumentKey = null;
  applyTheme();
  saveThemePreference();
}

function renderWindow(value = floatingState) {
  if (!value) return;
  const previous = floatingState;
  floatingState = value;
  const active = value.status !== "attached";
  const ownWindow = isFloating && value.id === windowId && active;
  if (ownWindow && !windowInitialized) {
    windowInitialized = true;
    restoreView(value.view);
    scheduleViewPublish();
  } else if (!isFloating && previous && previous.status !== "attached" && !active) {
    restoreView(value.view);
    renderChrome({ history: true });
    void ensureRevision();
  }
  const returned = isFloating && !ownWindow;
  const away = !isFloating && active;
  $("#popout").hidden = isFloating || active;
  $("#popout").disabled = movingWindow || !state;
  $("#popin").hidden = !ownWindow;
  $("#popin").disabled = movingWindow || value.status !== "detached";
  $("#floating-notice").hidden = !away && !returned;
  $("#main-content").hidden = away || returned;
  $("#panel-footer").hidden = away || returned;
  $("#bring-back").hidden = !away;
  $("#bring-back").disabled = movingWindow || value.status === "closing";
  $("#floating-title").textContent = returned ? "Plan history returned to the panel"
    : value.status === "opening" ? "Opening a floating window" : "Plan history is in a floating window";
  $("#floating-message").textContent = returned ? "This window is no longer active. You can close it."
    : "Move the window to another monitor. It uses the same live plan and saved history.";
  const error = windowError ?? value.error;
  $("#window-error").textContent = error?.message ?? error ?? "";
  $("#window-error").hidden = !error;
}

function scheduleViewPublish() {
  clearTimeout(publishTimer);
  if (!isFloating || disposed || movingWindow || floatingState?.id !== windowId || floatingState?.status !== "detached") return;
  publishTimer = setTimeout(async () => {
    const value = currentView();
    const serialized = JSON.stringify(value);
    if (serialized === publishedView) return;
    try {
      await request("/api/window-view", { method: "POST", body: { windowId, view: value } });
      publishedView = serialized;
      windowError = null;
    } catch (error) {
      if (disposed) return;
      windowError = error;
    }
    renderWindow();
  }, 200);
}

async function moveWindow(detach) {
  if (movingWindow) return;
  movingWindow = true;
  windowError = null;
  clearTimeout(publishTimer);
  renderWindow();
  try {
    const body = detach ? { view: currentView() }
      : { windowId: isFloating ? windowId : floatingState?.id ?? null, ...(isFloating ? { view: currentView() } : {}) };
    const result = await request(detach ? "/api/detach" : "/api/attach", { method: "POST", body });
    renderWindow(result);
    if (!detach && isFloating) window.close();
  } catch (error) {
    windowError = error;
  } finally {
    movingWindow = false;
    renderWindow();
    void refreshState();
  }
}

function shortId(id) {
  return entryById.get(id)?.shortId || id?.slice(0, 7) || "";
}

function formatDate(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date);
}

function timeElement(value) {
  const element = make("time", "", formatDate(value));
  if (value) {
    element.dateTime = value;
    element.title = value;
  }
  return element;
}

function rememberHistory(page) {
  for (const entry of page.entries) entryById.set(entry.id, entry);
  const last = page.entries.at(-1);
  if (last) pageCursors.set(last.id, page.nextCursor);
  rebuildHistory();
}

function rebuildHistory() {
  const chain = [];
  const seen = new Set();
  let id = state?.head ?? state?.history.entries[0]?.id;
  while (id && entryById.has(id) && !seen.has(id)) {
    const entry = entryById.get(id);
    chain.push(entry);
    seen.add(id);
    id = entry.parent;
  }
  entries = chain;
  const last = entries.at(-1);
  nextCursor = last ? (pageCursors.has(last.id) ? pageCursors.get(last.id) : last.parent ? last.id : null) : null;
}

function currentUnavailable() {
  return Boolean(readError || state?.error || state?.status === "error");
}

function latestTarget() {
  return state?.working ? "working" : state?.head ?? entries[0]?.id ?? null;
}

function sequence() {
  return [...(state?.working ? ["working"] : []), ...entries.map((entry) => entry.id)];
}

function selectedKey() {
  return selectedId === "working" ? `working:${state?.current.digest ?? "missing"}:${state?.current.exists}:${state?.head ?? ""}` : selectedId;
}

function delayLabel() {
  const seconds = Number.isFinite(state?.capture.delayMs) ? state.capture.delayMs / 1000 : 5;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function renderStatus() {
  const error = readError ?? state?.error ?? (state?.status === "error"
    ? apiError("The native plan is unavailable. Retry or browse a saved revision.", "PLAN_UNAVAILABLE") : null) ?? captureError;
  $("#error-banner").hidden = !error;
  if (error) {
    $("#error-title").textContent = error === captureError ? "Snapshot was not captured" : "Unable to read the current plan";
    $("#error-message").textContent = error.message;
    $("#error-code").textContent = error.code ?? "";
    $("#error-code").hidden = !error.code;
  }
  let notice = "";
  if (!currentUnavailable() && state?.status === "missing") {
    notice = "The native plan file is missing. Saved revisions are still available; restore the file to resume tracking.";
  } else if (currentUnavailable() && entries.length) {
    notice = "Current plan unavailable. You can still browse saved revisions below.";
  }
  $("#status-banner").textContent = notice;
  $("#status-banner").hidden = !notice;
  $("#empty-state").hidden = Boolean(selectedId) || Boolean(error);
  if (!selectedId && !error && state) {
    const waiting = !state.current.exists && !entries.length;
    $("#empty-title").textContent = waiting ? "Waiting for your native plan" : "Waiting for the first saved revision";
    $("#empty-message").textContent = waiting
      ? "Start native Plan mode; history begins when plan.md appears."
      : `Your plan will be captured after ${delayLabel()} without edits.`;
  }
}

function renderNavigation() {
  const ids = sequence();
  const index = ids.indexOf(selectedId);
  $("#history-area").hidden = !ids.length && !selectedId;
  $("#history-trigger").disabled = !ids.length;
  $("#position").textContent = selectedId === "working" ? "Working changes"
    : selectedId ? `Revision ${shortId(selectedId)}` : "Saved revisions";
  $("#previous").disabled = index === -1 || (index === ids.length - 1 && (!nextCursor || Boolean(historyRequest)));
  $("#next").disabled = index <= 0;
  const nextLabel = index > 0 && ids[index - 1] === "working" ? "View working changes" : "Next revision";
  $("#next").setAttribute("aria-label", nextLabel);
  $("#next").title = nextLabel;
}

function renderHistory() {
  const target = $("#history");
  const scroll = target.scrollTop;
  const focused = target.contains(document.activeElement) ? document.activeElement.dataset.revision ?? "load-older" : null;
  const fragment = document.createDocumentFragment();
  const buttons = new Map();
  if (state?.working) {
    const button = make("button", `commit working${selectedId === "working" ? " active" : ""}`);
    button.dataset.revision = "working";
    button.setAttribute("aria-pressed", String(selectedId === "working"));
    const title = make("strong");
    title.append(make("span", "working-dot"), document.createTextNode("Working changes"));
    button.append(title, make("small", "", currentUnavailable() ? "Current plan unavailable"
      : state.current.exists ? "Current plan / not yet captured" : "File missing / not yet captured"));
    button.addEventListener("click", () => selectRevision("working"));
    fragment.append(button);
    buttons.set("working", button);
    if (entries.length) fragment.append(make("div", "history-divider"));
  }
  for (const entry of entries) {
    const button = make("button", `commit${selectedId === entry.id ? " active" : ""}`);
    button.dataset.revision = entry.id;
    button.setAttribute("aria-pressed", String(selectedId === entry.id));
    const title = make("strong", "", entry.title || "Saved revision");
    if (entry.id === state.head) title.prepend(make("span", "latest-label", "Latest saved"));
    const meta = make("small");
    meta.append(make("code", "", shortId(entry.id)), document.createTextNode("·"), timeElement(entry.createdAt));
    button.append(title, meta);
    button.addEventListener("click", () => selectRevision(entry.id));
    fragment.append(button);
    buttons.set(entry.id, button);
  }
  if (nextCursor) {
    const more = make("button", "text-button load-older", historyRequest ? "Loading older revisions…" : "Load older revisions");
    more.disabled = Boolean(historyRequest);
    more.addEventListener("click", () => loadOlder());
    fragment.append(more);
    buttons.set("load-older", more);
  }
  target.replaceChildren(fragment);
  if (focused && buttons.has(focused)) buttons.get(focused).focus({ preventScroll: true });
  target.scrollTop = scroll;
  $("#history-error").replaceChildren();
  $("#history-error").hidden = !historyError;
  if (historyError) {
    $("#history-error").append(document.createTextNode(historyError.message));
    const retry = make("button", "text-button", "Retry older revisions");
    retry.addEventListener("click", () => loadOlder());
    $("#history-error").append(retry);
  }
}

function renderRevisionHeader() {
  $("#revision").hidden = !selectedId;
  if (!selectedId) return;
  const isWorking = selectedId === "working";
  const entry = entryById.get(selectedId);
  const selectedRevision = revisionKey === selectedKey() ? revision : null;
  $("#revision-title").textContent = isWorking ? "Working changes" : selectedRevision?.title || entry?.title || "Saved revision";
  $("#revision-hash").textContent = isWorking ? "plan.md" : shortId(selectedId);
  $("#revision-hash").title = isWorking ? state?.planPath ?? "plan.md" : selectedId;
  const date = isWorking ? null : selectedRevision?.createdAt ?? entry?.createdAt;
  $("#revision-time").hidden = !date;
  $("#time-separator").hidden = !date;
  $("#revision-time").textContent = date ? formatDate(date) : "";
  $("#revision-time").dateTime = date ?? "";
  $("#revision-time").title = date ?? "";
  const badge = $("#latest-badge");
  badge.hidden = !isWorking && selectedId !== state?.head;
  badge.textContent = isWorking ? currentUnavailable() ? "Unavailable" : state?.current.exists ? "Not yet captured" : "File missing" : "Latest saved";
  badge.classList.toggle("working", isWorking);
  const latest = latestTarget();
  $("#jump-latest").hidden = !latest || selectedId === latest;
  $("#jump-latest").textContent = latest === "working" ? "View working changes" : "Go to latest saved";
  $("#capture-controls").hidden = !isWorking || !state?.working || currentUnavailable();
  $("#capture-status").textContent = capturing ? "Saving a local snapshot…" : `Auto-captures after ${delayLabel()} without edits.`;
  $("#capture").disabled = capturing;
  $("#capture").textContent = capturing ? "Capturing…" : "Capture now";
}

function renderChrome({ history = false } = {}) {
  if (state) {
    $("#plan-title").textContent = state.title || "Native session plan";
    $("#plan-file").textContent = state.planPath?.split(/[\\/]/).at(-1) || "plan.md";
    $("#plan-file").title = state.planPath || "plan.md";
    $("#capture-delay").textContent = delayLabel();
  }
  renderStatus();
  renderNavigation();
  renderRevisionHeader();
  if (history) renderHistory();
}

function changeLine(line) {
  if (line.type === "notice") return make("p", "diff-notice", line.text);
  const row = make("div", `change-line ${line.type}`);
  const number = line.type === "remove" ? line.oldLine : line.newLine;
  if (number !== null && number !== undefined) row.title = `${line.type === "remove" ? "Old" : "New"} line ${number}`;
  row.append(make("span", "sign", line.type === "add" ? "+" : line.type === "remove" ? "−" : " "),
    make("span", "text", line.text || " "));
  return row;
}

function renderDiff(value) {
  const target = make("div", showContext ? "diff show-context" : "diff");
  const comparison = make("div", "comparison");
  const counts = make("span", "counts");
  counts.setAttribute("aria-label", `${value.diff.added} added lines, ${value.diff.removed} removed lines`);
  counts.append(make("span", "added-count", `+${value.diff.added}`), make("span", "removed-count", `−${value.diff.removed}`));
  const description = value.parent ? value.isWorking
    ? `Since latest saved revision (${shortId(value.parent)})` : `Compared with previous revision (${shortId(value.parent)})`
    : value.isWorking ? "Compared with an empty plan; no saved revision yet" : "First saved version of this plan";
  comparison.append(make("span", "", description), counts);
  target.append(comparison);
  if (!value.exists) target.append(make("p", "plan-label", "The plan file does not exist in this version."));
  if (value.diff.lines.some((line) => line.type === "context")) {
    const disclosure = make("details", "surrounding");
    disclosure.open = showContext;
    disclosure.append(make("summary", "", "Show surrounding context"),
      make("p", "", "Git includes up to three unchanged lines around each change, not every unchanged line in the plan."));
    disclosure.addEventListener("toggle", () => {
      showContext = disclosure.open;
      target.classList.toggle("show-context", showContext);
      scheduleViewPublish();
    });
    target.append(disclosure);
  }
  let block = null;
  for (const line of value.diff.lines) {
    if (line.type === "hunk" || !block) {
      const group = make("section", "change-group");
      if (line.type === "hunk") group.append(make("h3", "hunk-title", line.text));
      block = make("div", "change-block");
      group.append(block);
      target.append(group);
      if (line.type === "hunk") continue;
    }
    block.append(changeLine(line));
  }
  if (!value.diff.added && !value.diff.removed) {
    target.append(make("p", "empty", "No line changes in this revision."));
  }
  return target;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function safeMarkdown(content) {
  if (!window.marked?.parse || !window.DOMPurify?.sanitize) {
    throw apiError("The Markdown renderer did not load. Refresh to retry; the plan has not been changed.", "RENDERER_UNAVAILABLE");
  }
  const renderer = new window.marked.Renderer();
  renderer.html = () => "";
  renderer.image = (image, _title, text) => {
    const alt = typeof image === "object" ? image.text : text;
    return `<em>${escapeHtml(alt ? `[Image omitted: ${alt}]` : "[Image omitted]")}</em>`;
  };
  renderer.checkbox = (checkbox) => (typeof checkbox === "object" ? checkbox.checked : checkbox) ? "[x] " : "[ ] ";
  const html = window.marked.parse(content, { renderer, async: false, gfm: true });
  const fragment = window.DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote",
      "pre", "code", "em", "strong", "del", "s", "a", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["href", "title", "start"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  for (const link of fragment.querySelectorAll("a")) {
    try {
      const url = new URL(link.getAttribute("href") ?? "");
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsupported link");
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
    } catch {
      link.removeAttribute("href");
      link.title = "Only absolute HTTP(S) links can be opened from this read-only preview.";
    }
  }
  return fragment;
}

function renderPlan(value) {
  const target = make("div");
  target.append(make("p", "plan-label", value.isWorking ? "Current plan, including edits not yet captured."
    : `Complete plan saved at ${shortId(value.id)}. This is a snapshot, not the live file.`));
  if (!value.exists) {
    target.append(make("p", "empty", value.isWorking
      ? "The native plan file is missing. Earlier saved revisions remain in history."
      : "The plan file did not exist in this saved revision."));
  } else if (!value.content.trim()) {
    target.append(make("p", "empty", "The plan file is empty in this version."));
  } else {
    const article = make("article", "plan");
    article.append(safeMarkdown(value.content));
    target.append(article);
  }
  return target;
}

function revisionFailure(error) {
  const box = make("div", "revision-error");
  box.setAttribute("role", "alert");
  box.append(make("h3", "", error.status === 404 ? "This revision is unavailable" : "Unable to display this revision"),
    make("p", "", error.message),
    make("p", "", "Your selection has been kept. Retry, refresh, or choose another revision."));
  if (error.code) box.append(make("code", "error-code", error.code));
  const retry = make("button", "text-button", "Retry revision");
  retry.addEventListener("click", () => ensureRevision(true));
  box.append(retry);
  return box;
}

function renderDocument() {
  const target = $("#document");
  if (!selectedId) {
    target.replaceChildren();
    renderedDocumentKey = null;
    return;
  }
  if (selectedId === "working" && currentUnavailable()) {
    target.setAttribute("aria-busy", "false");
    target.replaceChildren(make("p", "empty", "Current plan unavailable. No stale working content is shown."));
    renderedDocumentKey = null;
    return;
  }
  const key = selectedKey();
  if (revisionError) {
    target.setAttribute("aria-busy", "false");
    target.replaceChildren(revisionFailure(revisionError));
    renderedDocumentKey = null;
    return;
  }
  if (!revision || revisionKey !== key) {
    target.setAttribute("aria-busy", "true");
    target.replaceChildren(make("p", "empty", "Loading revision…"));
    renderedDocumentKey = null;
    return;
  }
  target.setAttribute("aria-busy", "false");
  const documentKey = `${key}:${view}`;
  if (renderedDocumentKey === documentKey) return;
  try {
    target.replaceChildren(view === "diff" ? renderDiff(revision) : renderPlan(revision));
    renderedDocumentKey = documentKey;
    if (restoreScroll !== null) {
      const position = restoreScroll;
      restoreScroll = null;
      requestAnimationFrame(() => window.scrollTo({ top: position, behavior: "instant" }));
    }
  } catch (error) {
    target.replaceChildren(revisionFailure(error));
    renderedDocumentKey = null;
  }
}

async function ensureRevision(force = false) {
  if (!selectedId || (selectedId === "working" && currentUnavailable())) {
    revisionController?.abort();
    revisionLoadingKey = null;
    revisionGeneration++;
    renderDocument();
    return;
  }
  const id = selectedId;
  const key = selectedKey();
  if (!force && ((revisionKey === key && !revisionError) || revisionLoadingKey === key)) {
    renderDocument();
    return;
  }
  revisionController?.abort();
  revisionController = new AbortController();
  const generation = ++revisionGeneration;
  revisionLoadingKey = key;
  revisionError = null;
  renderDocument();
  try {
    const result = validateRevision(await request(`/api/revision?id=${encodeURIComponent(id)}`, { signal: revisionController.signal }), id);
    if (generation !== revisionGeneration || id !== selectedId || key !== selectedKey()) return;
    revision = result;
    revisionKey = key;
    revisionError = null;
  } catch (error) {
    if (generation !== revisionGeneration || error.name === "AbortError") return;
    revisionError = error;
    revision = null;
    revisionKey = null;
  } finally {
    if (generation === revisionGeneration) {
      revisionLoadingKey = null;
      renderRevisionHeader();
      renderDocument();
    }
  }
}

function selectRevision(id, { follow = id === "working", closeHistory = true } = {}) {
  if (!id) return;
  selectedId = id;
  followLatest = follow;
  revisionError = null;
  if (closeHistory && !$("#history").hidden) {
    setExpanded("#history-trigger", "#history", false);
    $("#history-trigger").focus({ preventScroll: true });
  }
  renderChrome({ history: true });
  void ensureRevision();
  scheduleViewPublish();
}

function applyState(value, forceRevision = false) {
  const changed = state?.version !== value.version;
  const recovered = Boolean(readError) || (currentUnavailable() && !value.error && value.status !== "error");
  if (state?.head !== value.head && !value.error && value.status !== "error") captureError = null;
  readError = null;
  state = value;
  if (value.floating) renderWindow(value.floating);
  if (changed || recovered) rememberHistory(value.history);
  if (!changed && !recovered && !forceRevision) return;
  const target = latestTarget();
  if (!selectedId || followLatest || (selectedId === "working" && !state.working)) selectedId = target;
  if (selectedId === "working" && !state.working) selectedId = state.head;
  if (changed || recovered) revisionError = null;
  renderChrome({ history: true });
  void ensureRevision(forceRevision || (recovered && selectedId === "working"));
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (disposed || !validToken || readError?.status === 401 || readError?.status === 403) return;
  pollTimer = setTimeout(() => refreshState(), document.hidden ? 5000 : 1000);
}

function refreshState(forceRevision = false) {
  if (stateRequest) return stateRequest;
  clearTimeout(pollTimer);
  $("#refresh").disabled = true;
  $("#retry").disabled = true;
  stateRequest = (async () => {
    try {
      applyState(validateState(await request("/api/state")), forceRevision);
    } catch (error) {
      if (disposed) return;
      readError = error;
      renderChrome({ history: true });
      if (selectedId === "working") {
        revisionController?.abort();
        revisionGeneration++;
        revisionLoadingKey = null;
      }
      renderDocument();
    } finally {
      stateRequest = null;
      $("#refresh").disabled = false;
      $("#retry").disabled = false;
      schedulePoll();
    }
  })();
  return stateRequest;
}

function loadOlder() {
  if (historyRequest) return historyRequest;
  if (!nextCursor) return Promise.resolve(false);
  const cursor = nextCursor;
  historyError = null;
  historyRequest = (async () => {
    try {
      const page = validateHistory(await request(`/api/history?before=${encodeURIComponent(cursor)}`));
      if (!page.entries.length && page.nextCursor) throw apiError("The history service returned an empty page with more revisions pending.", "INVALID_RESPONSE");
      if (page.nextCursor === cursor) throw apiError("The history service did not advance to an older page.", "INVALID_RESPONSE");
      if (!page.entries.length) pageCursors.set(cursor, null);
      rememberHistory(page);
      return true;
    } catch (error) {
      historyError = error;
      return false;
    } finally {
      historyRequest = null;
      renderNavigation();
      renderHistory();
    }
  })();
  renderNavigation();
  renderHistory();
  return historyRequest;
}

async function movePrevious() {
  const original = selectedId;
  let ids = sequence();
  let index = ids.indexOf(original);
  if (index < 0) return;
  if (index === ids.length - 1 && nextCursor) {
    const loaded = await loadOlder();
    if (!loaded || selectedId !== original) return;
    ids = sequence();
    index = ids.indexOf(original);
  }
  if (ids[index + 1]) selectRevision(ids[index + 1]);
}

async function captureNow() {
  if (capturing || !state?.working || currentUnavailable()) return;
  capturing = true;
  captureError = null;
  renderChrome();
  try {
    applyState(validateState(await request("/api/capture", { method: "POST" })));
  } catch (error) {
    captureError = error;
  } finally {
    capturing = false;
    renderChrome({ history: true });
  }
}

$("#history-trigger").addEventListener("click", () => {
  setExpanded("#history-trigger", "#history", $("#history").hidden);
  scheduleViewPublish();
});
$("#previous").addEventListener("click", movePrevious);
$("#next").addEventListener("click", () => {
  const ids = sequence();
  const index = ids.indexOf(selectedId);
  if (index > 0) selectRevision(ids[index - 1]);
});
$("#jump-latest").addEventListener("click", () => selectRevision(latestTarget(), { follow: true }));
$("#capture").addEventListener("click", captureNow);
$("#popout").addEventListener("click", () => moveWindow(true));
$("#popin").addEventListener("click", () => moveWindow(false));
$("#bring-back").addEventListener("click", () => moveWindow(false));
$("#refresh").addEventListener("click", () => refreshState(true));
$("#retry").addEventListener("click", () => {
  captureError = null;
  void refreshState(true);
});
$("#info-trigger").addEventListener("click", () => setExpanded("#info-trigger", "#info", $("#info").hidden));
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
  view = button.dataset.view;
  document.querySelectorAll("[data-view]").forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  renderDocument();
  scheduleViewPublish();
}));
window.addEventListener("scroll", scheduleViewPublish, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshState();
});
window.addEventListener("pagehide", () => {
  disposed = true;
  clearTimeout(pollTimer);
  clearTimeout(publishTimer);
  revisionController?.abort();
  activeRequestController?.abort();
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  disposed = false;
  void refreshState();
});

if (validToken) {
  void refreshState();
} else {
  readError = apiError("This panel link is missing its access token. Reopen Plan Time Machine from Copilot.", "INVALID_TOKEN");
  renderChrome();
}
