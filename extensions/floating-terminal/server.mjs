// One loopback server for the whole extension process.
//
// Deliberately *not* one server per canvas instance: the panel iframe and the
// detached window must reach the same origin so they can attach to the same
// PTY. Terminals are addressed by the `t` query parameter.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { environmentProblem, getOrCreateTerminal, getTerminal, listTerminals } from "./terminals.mjs";
import { openFloatingWindow } from "./detach.mjs";

/**
 * Identifies this extension process. Loopback ports are ephemeral and get
 * recycled, so a floating window left over from a previous process could
 * otherwise reconnect to an unrelated server and attach to the wrong terminal.
 */
const BOOT_ID = randomUUID();

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, "ui");
const xtermDir = path.join(here, "node_modules", "@xterm");

const STATIC_ROUTES = {
    "/": { file: path.join(uiDir, "index.html"), type: "text/html; charset=utf-8" },
    "/app.js": { file: path.join(uiDir, "app.js"), type: "text/javascript; charset=utf-8" },
    "/styles.css": { file: path.join(uiDir, "styles.css"), type: "text/css; charset=utf-8" },
    "/vendor/xterm.js": { file: path.join(xtermDir, "xterm", "lib", "xterm.js"), type: "text/javascript; charset=utf-8" },
    "/vendor/xterm.css": { file: path.join(xtermDir, "xterm", "css", "xterm.css"), type: "text/css; charset=utf-8" },
    "/vendor/addon-fit.js": {
        file: path.join(xtermDir, "addon-fit", "lib", "addon-fit.js"),
        type: "text/javascript; charset=utf-8",
    },
};

let started = null;

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
}

async function handleStatic(route, res) {
    try {
        const content = await readFile(route.file);
        res.writeHead(200, { "Content-Type": route.type, "Cache-Control": "no-store" });
        res.end(content);
    } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Failed to read asset: ${error.message}`);
    }
}

/**
 * Move a terminal into a floating OS window. The panel keeps its socket open so
 * it can show a placeholder and offer to pull the terminal back.
 *
 * The window is sized to the shell's current dimensions so the new surface can
 * adopt the existing grid rather than changing it merely by attaching.
 */
async function detachTerminal(terminal, origin) {
    if (terminal.windowProcess) return { alreadyDetached: true };

    const url = `${origin}/?t=${encodeURIComponent(terminal.id)}&mode=detached&boot=${BOOT_ID}`;
    const { mode, browser, child } = await openFloatingWindow(url, windowSizeFor(terminal));
    terminal.windowProcess = child;

    child.on("exit", () => {
        terminal.windowProcess = null;
        terminal.broadcastState();
    });

    return { mode, browser, url };
}

/**
 * Pixel size of a window that can comfortably hold a terminal grid.
 *
 * Deliberately generous. If the window comes up even one row or column short,
 * the surface re-fits instead of adopting. Measured cells are ~7.65x15px with
 * ~43px of toolbar, so these round up and leave slack for the OS window frame.
 */
function windowSizeFor(terminal) {
    const CELL_W = 8;
    const CELL_H = 16;
    const CHROME_W = 60;
    const CHROME_H = 160;
    const cols = terminal.cols || 100;
    const rows = terminal.rows || 30;
    return {
        width: Math.min(2400, Math.max(520, Math.round(cols * CELL_W + CHROME_W))),
        height: Math.min(1500, Math.max(360, Math.round(rows * CELL_H + CHROME_H))),
    };
}

function reattachTerminal(terminal) {
    if (!terminal.windowProcess) return { alreadyAttached: true };
    terminal.windowProcess.kill();
    terminal.windowProcess = null;
    terminal.broadcastState();
    return { ok: true };
}

export async function ensureServer() {
    if (started) return started;

    started = (async () => {
        const server = createServer(async (req, res) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            const route = STATIC_ROUTES[url.pathname];
            if (route) return handleStatic(route, res);

            const origin = `http://127.0.0.1:${server.address().port}`;
            const terminalId = url.searchParams.get("t") ?? "";
            const terminal = terminalId ? getTerminal(terminalId) : null;

            if (url.pathname === "/api/state") {
                return sendJson(res, 200, {
                    problem: await environmentProblem(),
                    terminals: listTerminals(),
                    terminal: terminal
                        ? { terminalId: terminal.id, detached: terminal.detached, exited: terminal.exited, cwd: terminal.cwd }
                        : null,
                });
            }

            if (url.pathname === "/api/detach" && req.method === "POST") {
                if (!terminal) return sendJson(res, 404, { error: "unknown terminal" });
                try {
                    return sendJson(res, 200, await detachTerminal(terminal, origin));
                } catch (error) {
                    return sendJson(res, 500, { error: String(error.message ?? error) });
                }
            }

            if (url.pathname === "/api/attach" && req.method === "POST") {
                if (!terminal) return sendJson(res, 404, { error: "unknown terminal" });
                return sendJson(res, 200, reattachTerminal(terminal));
            }

            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("not found");
        });

        const wss = new WebSocketServer({ server, path: "/ws" });

        wss.on("connection", async (socket, req) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            const terminalId = url.searchParams.get("t");
            const mode = url.searchParams.get("mode") === "detached" ? "detached" : "panel";
            const boot = url.searchParams.get("boot");
            if (!terminalId) return socket.close(1008, "missing terminal id");

            // 4001 tells the client this is a stale surface from a dead process,
            // so it stops retrying instead of hijacking a recycled port.
            if (boot && boot !== BOOT_ID) return socket.close(4001, "stale boot id");

            // Refuse to start a terminal in an environment we can't support,
            // and say why, rather than degrading silently.
            const problem = await environmentProblem();
            if (problem) {
                socket.send(JSON.stringify({ type: "notice", message: problem }));
                return;
            }

            const terminal = getOrCreateTerminal(terminalId, { cwd: url.searchParams.get("cwd") ?? undefined });
            const client = { socket, mode, cols: 0, rows: 0 };
            terminal.addClient(client);

            let handedOff = false;

            /**
             * Start (or attach to) the shell once the viewport size is settled,
             * and only then replay history, so the client never renders against
             * a size the shell hasn't seen.
             */
            const handOff = async () => {
                if (handedOff) return;
                handedOff = true;

                await terminal.ensureStarted(client.cols || undefined, client.rows || undefined);

                // Resize before snapshotting so the snapshot is rendered at this
                // surface's dimensions rather than the previous owner's.
                if (terminal.needsResize()) await terminal.applyResize();
                else await terminal.sendSnapshot(client);

                terminal.broadcastState();
                if (terminal.exited && socket.readyState === 1) {
                    socket.send(JSON.stringify({ type: "exit", code: terminal.exitCode }));
                }
            };

            // If the client never speaks up (unexpected), don't hang.
            const fallback = setTimeout(handOff, 1500);

            let resizeTimer = null;
            socket.on("message", (raw) => {
                let message;
                try {
                    message = JSON.parse(raw.toString());
                } catch {
                    return;
                }

                if (message.type === "hello") {
                    // A surface joining an existing shell adopts its dimensions
                    // rather than resizing it; resizing an already-running shell
                    // disturbs the prompt for no benefit.
                    if (terminal.started) {
                        socket.send(JSON.stringify({ type: "adopt", cols: terminal.cols, rows: terminal.rows }));
                    } else {
                        socket.send(JSON.stringify({ type: "usefit" }));
                    }
                    return;
                }

                if (message.type === "adopted") {
                    client.cols = message.cols;
                    client.rows = message.rows;
                    clearTimeout(fallback);
                    void handOff();
                    return;
                }

                if (message.type === "input") terminal.write(message.data);
                else if (message.type === "resize") {
                    client.cols = message.cols;
                    client.rows = message.rows;
                    if (!handedOff) {
                        clearTimeout(fallback);
                        void handOff();
                        return;
                    }
                    // Coalesce drag-resizes, then re-sync every surface so none
                    // is left rendering history wrapped at the previous width.
                    clearTimeout(resizeTimer);
                    resizeTimer = setTimeout(() => void terminal.applyResize(), 150);
                }
            });

            socket.on("close", () => {
                clearTimeout(fallback);
                clearTimeout(resizeTimer);
                terminal.removeClient(client);
            });
        });

        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address();
        return { port, origin: `http://127.0.0.1:${port}` };
    })();

    return started;
}

export function bootId() {
    return BOOT_ID;
}
