// Extension: floating-terminal
//
// A terminal canvas that can be detached into a floating OS window, so it can
// live on a different monitor from the main app window.
//
// How it works: a canvas is just a URL this extension serves. We run one
// loopback server for the whole extension and let two surfaces — the canvas
// panel and an independent OS window — attach to the same PTY over WebSocket.
// The PTY is keyed by a durable `terminalId`, never by `instanceId`, so the
// terminal survives iframe reloads, re-opens, and fresh instance IDs.

import process from "node:process";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

import { ensureServer, bootId } from "./server.mjs";
import { disposeAll, environmentProblem, getOrCreateTerminal, getTerminal, listTerminals } from "./terminals.mjs";

/**
 * Maps a panel instance to the terminal it opened. Action requests don't carry
 * the original open input, so without this an action on an instance that was
 * opened with an explicit `terminalId` would look for a terminal named after
 * the instance instead.
 */
const instanceTerminals = new Map();

/** Resolve the durable terminal ID for an open/action request. */
function resolveTerminalId(ctx) {
    const fromInput = ctx.input && typeof ctx.input === "object" ? ctx.input.terminalId : undefined;
    if (typeof fromInput === "string" && fromInput.length > 0) return fromInput;
    return instanceTerminals.get(ctx.instanceId) ?? ctx.instanceId;
}

function requireTerminal(terminalId) {
    const terminal = getTerminal(terminalId);
    if (!terminal) throw new CanvasError("terminal_not_found", `No terminal with id "${terminalId}".`);
    return terminal;
}

const terminalCanvas = createCanvas({
    id: "floating-terminal",
    displayName: "Floating terminal",
    description: "A shell terminal that can be popped out of the panel into its own OS window for multi-monitor setups.",
    inputSchema: {
        type: "object",
        properties: {
            terminalId: {
                type: "string",
                description: "Durable ID for the terminal session. Re-opening with the same ID reattaches to the same shell.",
            },
            cwd: { type: "string", description: "Working directory for the shell. Defaults to the session working directory." },
            detached: { type: "boolean", description: "Open directly in a floating window instead of the panel." },
        },
        additionalProperties: false,
    },
    actions: [
        {
            name: "run_command",
            description: "Type a command into the terminal and press Enter.",
            inputSchema: {
                type: "object",
                properties: {
                    terminalId: { type: "string" },
                    command: { type: "string", description: "Command text to send to the shell." },
                },
                required: ["command"],
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const terminal = requireTerminal(resolveTerminalId(ctx));
                // A terminal driven only by the agent may never have had a
                // viewport, so make sure a shell actually exists.
                await terminal.ensureStarted();
                terminal.write(`${ctx.input.command}\r`);
                return { ok: true, terminalId: terminal.id };
            },
        },
        {
            name: "detach",
            description: "Move the terminal out of the panel and into a floating window.",
            inputSchema: {
                type: "object",
                properties: { terminalId: { type: "string" } },
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const terminal = requireTerminal(resolveTerminalId(ctx));
                const { origin } = await ensureServer();
                const response = await fetch(`${origin}/api/detach?t=${encodeURIComponent(terminal.id)}`, { method: "POST" });
                return await response.json();
            },
        },
        {
            name: "attach",
            description: "Close the floating window and bring the terminal back into the panel.",
            inputSchema: {
                type: "object",
                properties: { terminalId: { type: "string" } },
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const terminal = requireTerminal(resolveTerminalId(ctx));
                const { origin } = await ensureServer();
                const response = await fetch(`${origin}/api/attach?t=${encodeURIComponent(terminal.id)}`, { method: "POST" });
                return await response.json();
            },
        },
        {
            name: "status",
            description: "List the terminals this extension is managing.",
            handler: async () => ({ problem: await environmentProblem(), terminals: listTerminals() }),
        },
    ],

    open: async (ctx) => {
        const { origin } = await ensureServer();
        const terminalId = resolveTerminalId(ctx);
        const cwd = ctx.input?.cwd ?? ctx.session?.workingDirectory;

        // Register the terminal so actions can address it immediately. The shell
        // itself is spawned once a surface reports its viewport size — spawning
        // at a guessed size and resizing later makes ConPTY blank the screen.
        const terminal = getOrCreateTerminal(terminalId, { cwd });
        instanceTerminals.set(ctx.instanceId, terminalId);

        if (ctx.input?.detached && !terminal.windowProcess) {
            await fetch(`${origin}/api/detach?t=${encodeURIComponent(terminalId)}`, { method: "POST" });
        }

        return {
            title: "Terminal",
            status: terminal.detached ? "In a floating window" : cwd,
            url: `${origin}/?t=${encodeURIComponent(terminalId)}&mode=panel&boot=${bootId()}`,
        };
    },

    onClose: async (ctx) => {
        const terminal = getTerminal(resolveTerminalId(ctx));
        instanceTerminals.delete(ctx.instanceId);
        // A terminal that's living in a floating window must outlive the panel
        // being closed — that window is still showing it.
        if (terminal && !terminal.windowProcess) terminal.dispose();
    },
});

const session = await joinSession({ canvases: [terminalCanvas] });

const { port } = await ensureServer();
const problem = await environmentProblem();
try {
    await session.log(
        problem
            ? `floating-terminal on 127.0.0.1:${port} — unsupported environment: ${problem.split("\n")[0]}`
            : `floating-terminal ready on 127.0.0.1:${port}`,
        { level: problem ? "warning" : "info", ephemeral: true },
    );
} catch {
    // Never let a diagnostic message take the extension down.
}

for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
        disposeAll();
        process.exit(0);
    });
}
