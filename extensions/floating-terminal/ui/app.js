/* global Terminal, FitAddon */

const params = new URLSearchParams(location.search);
const terminalId = params.get("t") ?? "default";
const mode = params.get("mode") === "detached" ? "detached" : "panel";
const boot = params.get("boot") ?? "";

const els = {
    title: document.getElementById("title"),
    badge: document.getElementById("badge"),
    popout: document.getElementById("popout"),
    popin: document.getElementById("popin"),
    overlay: document.getElementById("overlay"),
    bringBack: document.getElementById("bring-back"),
    notice: document.getElementById("notice"),
    noticeText: document.getElementById("notice-text"),
    host: document.getElementById("terminal"),
};

function themeColor(name, fallback) {
    const value = getComputedStyle(document.body).getPropertyValue(name).trim();
    return value || fallback;
}

const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontSize: 13,
    fontFamily: themeColor("--font-mono", '"Cascadia Mono", Consolas, "SFMono-Regular", monospace'),
    theme: {
        background: themeColor("--background-color-default", "#0d1117"),
        foreground: themeColor("--text-color-default", "#e6edf3"),
    },
});

const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(els.host);

// Exposed for debugging and for the test suite to read the live grid size.
window.__term = term;

let socket;
let detached = false;
// While adopting the shell's dimensions we deliberately do not fit to the
// viewport, so remember the container size that adoption was based on and only
// re-fit once the user actually resizes the surface.
let baseline = null;
function containerSize() {
    const r = els.host.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
}

function sendResize() {
    if (socket?.readyState !== WebSocket.OPEN) return;
    // The server waits for a valid size before spawning the shell, so never
    // report a bogus one from a not-yet-laid-out element.
    if (!Number.isFinite(term.cols) || !Number.isFinite(term.rows)) return;
    if (term.cols < 2 || term.rows < 2) return;
    socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
}

function refit() {
    try {
        fit.fit();
    } catch {
        /* the host element can be zero-sized while the panel animates */
    }
    baseline = containerSize();
    sendResize();
}

/**
 * Render at the shell's current size instead of our own. Attaching a surface
 * shouldn't resize a running shell: that forces the prompt to be re-established
 * and leaves an extra prompt line behind.
 */
function adopt(cols, rows) {
    const proposed = (() => {
        try {
            return fit.proposeDimensions();
        } catch {
            return null;
        }
    })();

    // Only adopt if the shell actually fits here; otherwise content would be
    // clipped and we're better off resizing.
    if (proposed && (cols > proposed.cols || rows > proposed.rows)) {
        refit();
        return;
    }

    term.resize(cols, rows);
    baseline = containerSize();
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "adopted", cols, rows }));
    }
}

function updateBadge() {
    const show = mode === "detached";
    els.badge.textContent = show ? "floating window" : "";
    els.badge.hidden = !show;
}

/** Re-fit only when the surface itself actually changed size. */
function maybeRefit() {
    if (!baseline) return;
    const size = containerSize();
    if (Math.abs(size.w - baseline.w) < 6 && Math.abs(size.h - baseline.h) < 6) return;
    refit();
}

/** The environment can't run a terminal; explain why instead of failing quietly. */
function showNotice(message) {
    els.notice.hidden = false;
    els.noticeText.textContent = message;
    els.overlay.hidden = true;
    els.popout.hidden = true;
    els.popin.hidden = true;
}

function applyState(next) {
    detached = Boolean(next.detached);

    // Only the panel steps aside when the terminal pops out. The floating
    // window is the one holding it, so it always keeps rendering.
    const showOverlay = mode === "panel" && detached;
    els.overlay.hidden = !showOverlay;
    els.popout.hidden = mode === "detached" || detached;
    els.popin.hidden = mode !== "detached";
    updateBadge();

    if (!showOverlay) maybeRefit();
}

function connect() {
    const wsUrl = `ws://${location.host}/ws?t=${encodeURIComponent(terminalId)}&mode=${mode}${
        boot ? `&boot=${encodeURIComponent(boot)}` : ""
    }`;
    socket = new WebSocket(wsUrl);

    socket.addEventListener("open", () => {
        term.focus();
        socket.send(JSON.stringify({ type: "hello", mode }));
    });

    socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "data") term.write(message.data);
        else if (message.type === "notice") showNotice(message.message);
        else if (message.type === "usefit") refit();
        else if (message.type === "adopt") adopt(message.cols, message.rows);
        else if (message.type === "snapshot") {
            // Authoritative screen state from the server, already rendered for
            // our current size. Reset first so no stale rows survive.
            term.reset();
            term.write(message.data);
        } else if (message.type === "state") applyState(message);
        else if (message.type === "exit") {
            term.write(`\r\n\x1b[90m[process exited with code ${message.code}]\x1b[0m\r\n`);
        }
    });

    // The extension process restarts on `extensions_reload`; reconnecting keeps
    // the surface usable instead of leaving a dead terminal behind. Code 4001
    // means we're a leftover window from a previous process, so we stop.
    socket.addEventListener("close", (event) => {
        if (event.code === 4001) {
            term.write("\r\n\x1b[90m[this window belongs to a previous session - closing]\x1b[0m\r\n");
            setTimeout(() => window.close(), 1500);
            return;
        }
        setTimeout(connect, 1000);
    });
}

term.onData((data) => {
    if (detached && mode === "panel") return;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
});

els.popout.addEventListener("click", async () => {
    els.popout.disabled = true;
    try {
        await fetch(`/api/detach?t=${encodeURIComponent(terminalId)}`, { method: "POST" });
    } finally {
        els.popout.disabled = false;
    }
});

els.bringBack.addEventListener("click", async () => {
    await fetch(`/api/attach?t=${encodeURIComponent(terminalId)}`, { method: "POST" });
});

els.popin.addEventListener("click", async () => {
    await fetch(`/api/attach?t=${encodeURIComponent(terminalId)}`, { method: "POST" });
    // The server closes this window; closing ourselves keeps it snappy and also
    // covers the case where the launch fell back to a normal browser tab.
    window.close();
});

new ResizeObserver(maybeRefit).observe(els.host);
window.addEventListener("resize", maybeRefit);

if (mode === "detached") {
    els.popin.hidden = false;
}
els.title.textContent = "Terminal";
updateBadge();
document.title = mode === "detached" ? `Terminal (floating) — ${terminalId}` : "Terminal";

// The server decides whether we fit to this surface or adopt the shell's size,
// so don't touch dimensions before the handshake.
connect();
