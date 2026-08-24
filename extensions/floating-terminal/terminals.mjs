// Shared PTY registry.
//
// One terminal can be viewed from the canvas panel *or* from a detached OS
// window without being two different terminals, so the process is keyed by a
// stable `terminalId` - a domain ID that survives iframe reloads and fresh
// instanceIds - never by `instanceId`.
//
// RESIZE
// ------
// A resize only resizes: emulator, pty, done. Nothing is written to the shell,
// so resizing cannot print a prompt line.
//
// This relies on a resize-safe PowerShell configuration. PowerShell 7 is
// required, predictive suggestions are disabled, and the prompt is bounded to
// the current directory's leaf name. The combination was verified against a
// raw pty with short and long wrapped commands in both resize directions.
//
// Windows PowerShell 5.1 is refused: its PSReadLine 2.0 loses the prompt
// position on routine resizes and has no silent recovery.

import { existsSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "noop.cjs"));
const { Terminal: HeadlessTerminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");

const SNAPSHOT_SCROLLBACK = 1000;
/** How long a terminal with no surfaces attached is kept before disposal. */
const REAP_AFTER_MS = 90_000;
const MAX_PROMPT_LEAF = 28;
const PWSH_BOOTSTRAP = [
    "Set-PSReadLineOption -PredictionSource None",
    "function global:prompt {",
    "  $leaf = Split-Path -Leaf (Get-Location).Path",
    "  if ([string]::IsNullOrWhiteSpace($leaf)) { $leaf = (Get-Location).Path }",
    `  if ($leaf.Length -gt ${MAX_PROMPT_LEAF}) { $leaf = $leaf.Substring(0, ${MAX_PROMPT_LEAF - 3}) + '...' }`,
    '  "PS $leaf> "',
    "}",
].join("; ");

/** @type {Map<string, Terminal>} */
const terminals = new Map();

let ptyModule;
let ptyError = null;

async function loadPty() {
    if (ptyModule !== undefined) return ptyModule;
    try {
        ptyModule = (await import("node-pty")).default ?? (await import("node-pty"));
    } catch (error) {
        ptyError = String(error.message ?? error);
        ptyModule = null;
    }
    return ptyModule;
}

/**
 * Whether an executable path is present.
 *
 * The Microsoft Store build of PowerShell 7 is only reachable through the App
 * Execution Alias in WindowsApps, which is an APPEXECLINK reparse point.
 * `existsSync` resolves it and fails with EACCES, so fall back to `lstatSync`,
 * which reports the link itself without following it.
 */
function executableExists(candidate) {
    if (existsSync(candidate)) return true;
    try {
        return lstatSync(candidate).isSymbolicLink();
    } catch {
        return false;
    }
}

/** Locate PowerShell 7+, or null if it isn't installed. */
function findPwsh() {
    if (process.platform !== "win32") return null;
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] ?? "";
    return (
        [
            path.join(pf, "PowerShell", "7", "pwsh.exe"),
            path.join(pf, "PowerShell", "8", "pwsh.exe"),
            path.join(pf86, "PowerShell", "7", "pwsh.exe"),
            path.join(local, "Microsoft", "WindowsApps", "pwsh.exe"),
        ].find((candidate) => executableExists(candidate)) ?? null
    );
}

function resolveShell() {
    if (process.platform !== "win32") {
        return { file: process.env.SHELL || "/bin/bash", args: ["-l"] };
    }
    const pwsh = findPwsh();
    return pwsh ? { file: pwsh, args: ["-NoLogo", "-NoExit", "-Command", PWSH_BOOTSTRAP] } : null;
}

/**
 * Why a terminal cannot start here, or null if it can.
 * @returns {Promise<string | null>}
 */
export async function environmentProblem() {
    if (!(await loadPty())) {
        return `The terminal backend could not be loaded.\n\nnode-pty failed to load: ${ptyError}`;
    }
    if (process.platform === "win32" && !findPwsh()) {
        return (
            "PowerShell 7 is required.\n\n" +
            "Windows PowerShell 5.1 ships a PSReadLine version that mis-renders the " +
            "prompt whenever the terminal is resized, which this panel does often.\n\n" +
            "Install it with:  winget install Microsoft.PowerShell"
        );
    }
    return null;
}

class Terminal {
    constructor(id, { cwd }) {
        this.id = id;
        this.cwd = cwd;
        /** @type {Set<{socket: import("ws").WebSocket, mode: string, cols: number, rows: number}>} */
        this.clients = new Set();
        /** @type {import("node:child_process").ChildProcess | null} */
        this.windowProcess = null;
        this.exited = false;
        this.exitCode = null;
        this.proc = null;
        this.starting = null;
        this.cols = 0;
        this.rows = 0;
        this.headless = null;
        this.serializer = null;
        this.lastDataAt = 0;
        this.shellFile = null;
        this.resizing = false;
        this.resizeQueued = false;
        this.resizeDone = null;
        this.reapTimer = null;
    }

    get started() {
        return this.proc !== null;
    }

    /**
     * Spawn the shell at a known viewport size.
     *
     * Deliberately lazy. Spawning at a guessed size and resizing afterwards
     * makes ConPTY clear the viewport without repainting, leaving a blank
     * screen, so we wait until a surface has reported its real dimensions.
     */
    async ensureStarted(cols = 120, rows = 30) {
        if (this.proc) return this;
        this.starting ??= this.#start(cols, rows);
        return this.starting;
    }

    async #start(cols, rows) {
        const pty = await loadPty();
        const resolved = resolveShell();
        if (!pty || !resolved) return this;

        // Authoritative screen state. Raw output bakes line wrapping in at the
        // width it was produced for, so replaying it into a differently sized
        // surface corrupts the layout. A headless emulator lets us hand every
        // surface a snapshot rendered at whatever size it actually is.
        this.headless = new HeadlessTerminal({ cols, rows, allowProposedApi: true, scrollback: SNAPSHOT_SCROLLBACK });
        this.serializer = new SerializeAddon();
        this.headless.loadAddon(this.serializer);

        this.shellFile = resolved.file;
        const p = pty.spawn(resolved.file, resolved.args, {
            name: "xterm-256color",
            cols,
            rows,
            cwd: this.cwd,
            env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
            useConpty: process.platform === "win32" ? true : undefined,
        });
        this.proc = p;

        p.onData((data) => {
            this.lastDataAt = Date.now();
            this.headless?.write(data);
            this.broadcast({ type: "data", data });
        });
        p.onExit(({ exitCode }) => {
            this.exited = true;
            this.exitCode = exitCode;
            this.broadcast({ type: "exit", code: exitCode });
        });

        this.cols = cols;
        this.rows = rows;
        return this;
    }

    // ---- clients ---------------------------------------------------------

    get detached() {
        for (const client of this.clients) if (client.mode === "detached") return true;
        return false;
    }

    /**
     * Only one surface drives the shell's dimensions at a time. A floating
     * window owns them while attached; otherwise the panel does. This stops the
     * shell being pulled between two differently sized viewports.
     */
    get sizeOwner() {
        let panel = null;
        for (const client of this.clients) {
            if (client.mode === "detached") return client;
            panel ??= client;
        }
        return panel;
    }

    needsResize() {
        const owner = this.sizeOwner;
        if (!owner || !this.proc) return false;
        if (owner.cols <= 0 || owner.rows <= 0) return false;
        return owner.cols !== this.cols || owner.rows !== this.rows;
    }

    /**
     * Attach a surface. Cancels any pending reap: a terminal whose last surface
     * went away is on death row, but a reconnecting iframe should rescue it.
     */
    addClient(client) {
        clearTimeout(this.reapTimer);
        this.reapTimer = null;
        this.clients.add(client);
    }

    removeClient(client) {
        this.clients.delete(client);
        // Losing the size owner (a floating window closing) hands sizing back to
        // the panel, which may want a different grid.
        if (this.needsResize()) void this.applyResize();
        this.broadcastState();
        this.#scheduleReap();
    }

    /**
     * Dispose a terminal nobody is looking at any more.
     *
     * Closing the canvas disposes explicitly, but a surface can also just
     * disconnect - a reloaded iframe, a closed window, a crashed page - and
     * without this the shell would live on forever holding memory. The grace
     * period is long enough that a reconnect reclaims the same terminal.
     */
    #scheduleReap() {
        clearTimeout(this.reapTimer);
        if (this.clients.size > 0 || this.windowProcess) return;
        this.reapTimer = setTimeout(() => {
            if (this.clients.size === 0 && !this.windowProcess) this.dispose();
        }, REAP_AFTER_MS);
    }

    /** Public entry point for the same check, used right after registration. */
    scheduleReapIfIdle() {
        this.#scheduleReap();
    }

    broadcast(message) {
        const payload = JSON.stringify(message);
        for (const client of this.clients) if (client.socket.readyState === 1) client.socket.send(payload);
    }

    broadcastState() {
        this.broadcast({ type: "state", detached: this.detached });
    }

    write(data) {
        if (!this.exited) this.proc?.write(data);
    }

    // ---- resize ----------------------------------------------------------

    /** Serialize resizes so a fast drag can't interleave them. */
    async applyResize() {
        if (this.resizing) {
            this.resizeQueued = true;
            return this.resizeDone;
        }
        this.resizing = true;
        this.resizeDone = (async () => {
            try {
                do {
                    this.resizeQueued = false;
                    await this.#doResize();
                } while (this.resizeQueued);
            } finally {
                this.resizing = false;
            }
        })();
        return this.resizeDone;
    }

    async #doResize() {
        const owner = this.sizeOwner;
        if (!owner || !this.proc || owner.cols <= 0 || owner.rows <= 0) return;
        if (owner.cols === this.cols && owner.rows === this.rows) return;

        this.cols = owner.cols;
        this.rows = owner.rows;
        this.headless?.resize(owner.cols, owner.rows);
        try {
            this.proc.resize(owner.cols, owner.rows);
        } catch {
            /* the pty may have exited between the check and the resize */
        }

        // The surface that drove the resize needs nothing from us: its own
        // xterm has already reflowed, and the shell's repaint reaches it as
        // ordinary output. Pushing a snapshot at it instead means resetting a
        // correct screen and re-rendering it from our emulator, and any
        // disagreement about the cursor lands the next keystroke a column out.
        //
        // Other surfaces do need telling: they are still sized to the old grid
        // and holding text wrapped for it.
        const others = [...this.clients].filter((c) => c !== owner);
        if (others.length === 0) return;

        await new Promise((r) => setTimeout(r, 120));
        await this.#waitIdle();
        await this.#flush();
        const payload = this.#payload();
        const adopt = JSON.stringify({ type: "adopt", cols: this.cols, rows: this.rows });
        for (const client of others) {
            if (client.socket.readyState !== 1) continue;
            client.socket.send(adopt);
            if (payload) client.socket.send(payload);
        }
    }

    // ---- screen state ----------------------------------------------------

    /** Wait for the headless emulator to finish parsing queued output. */
    #flush() {
        if (!this.headless) return Promise.resolve();
        return new Promise((resolve) => this.headless.write("", resolve));
    }

    /** Resolve once the shell has stopped producing output. */
    async #waitIdle(quietMs = 180, maxMs = 2000) {
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
            const quietFor = Date.now() - this.lastDataAt;
            if (quietFor >= quietMs) return;
            await new Promise((r) => setTimeout(r, Math.max(20, quietMs - quietFor)));
        }
    }

    /**
     * Serializing and sending happen with no await in between: a client resets
     * its screen before applying a snapshot, so live output that overtook the
     * snapshot would be wiped and lost.
     */
    #payload() {
        if (!this.serializer) return null;
        return JSON.stringify({
            type: "snapshot",
            data: this.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK }),
        });
    }

    async sendSnapshot(client) {
        await this.#flush();
        const payload = this.#payload();
        if (payload && client.socket.readyState === 1) client.socket.send(payload);
    }

    dispose() {
        clearTimeout(this.reapTimer);
        try {
            this.proc?.kill();
        } catch {
            /* already gone */
        }
        this.windowProcess?.kill();
        this.headless?.dispose();
        terminals.delete(this.id);
    }
}

/**
 * Look up or register a terminal. The shell is NOT spawned here - call
 * `ensureStarted(cols, rows)` once a real viewport size is known.
 */
export function getOrCreateTerminal(id, options = {}) {
    let terminal = terminals.get(id);
    if (terminal) return terminal;
    terminal = new Terminal(id, options);
    terminals.set(id, terminal);
    // Registered but not yet attached: reap it too, so a canvas that opens and
    // is never rendered doesn't linger in the map.
    terminal.scheduleReapIfIdle();
    return terminal;
}

export function getTerminal(id) {
    return terminals.get(id);
}

export function listTerminals() {
    return [...terminals.values()].map((t) => ({
        terminalId: t.id,
        cwd: t.cwd,
        started: t.started,
        detached: t.detached,
        exited: t.exited,
        clients: t.clients.size,
        size: t.started ? `${t.cols}x${t.rows}` : null,
        shell: t.shellFile ? path.basename(t.shellFile) : null,
    }));
}

export function disposeAll() {
    for (const terminal of [...terminals.values()]) terminal.dispose();
}
