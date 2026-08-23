import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { GitError, readChanges, readDiff, resolveRepository } from "./git.mjs";
import { openFloatingWindow } from "./detach.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, "ui");
const STATIC = {
    "/": [path.join(uiDir, "index.html"), "text/html; charset=utf-8"],
    "/app.js": [path.join(uiDir, "app.js"), "text/javascript; charset=utf-8"],
    "/styles.css": [path.join(uiDir, "styles.css"), "text/css; charset=utf-8"],
};

const byToken = new Map();
const byRoot = new Map();
let started = null;

function json(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
    });
    res.end(body);
}

function errorResponse(res, error) {
    const code = error instanceof GitError ? error.code : "internal_error";
    const message = String(error.message ?? error);
    json(res, code === "internal_error" ? 500 : 400, { error: { code, message } });
}

async function staticFile(res, [filePath, contentType]) {
    try {
        const body = await readFile(filePath);
        res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
        res.end(body);
    } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Failed to read asset: ${error.message}`);
    }
}

function requireWorkspace(url) {
    const token = url.searchParams.get("w");
    const workspace = token ? byToken.get(token) : null;
    if (!workspace) throw new GitError("workspace_not_found", "This Changes workspace is no longer registered.");
    return workspace;
}

export async function registerWorkspace(cwd) {
    const root = await resolveRepository(cwd);
    let workspace = byRoot.get(root);
    if (workspace) return workspace;
    workspace = {
        token: randomUUID(),
        root,
        references: 0,
        windowProcess: null,
        windowCleanup: null,
        detaching: null,
    };
    byRoot.set(root, workspace);
    byToken.set(workspace.token, workspace);
    return workspace;
}

export function retainWorkspace(workspace) {
    workspace.references++;
}

function pruneWorkspace(workspace) {
    if (workspace.references > 0 || workspace.windowProcess || workspace.detaching) return;
    if (byRoot.get(workspace.root) === workspace) byRoot.delete(workspace.root);
    if (byToken.get(workspace.token) === workspace) byToken.delete(workspace.token);
}

export function releaseWorkspace(workspace) {
    workspace.references = Math.max(0, workspace.references - 1);
    pruneWorkspace(workspace);
}

export async function workspaceState(workspace) {
    return { ...(await readChanges(workspace.root)), detached: Boolean(workspace.windowProcess) };
}

export async function detachWorkspace(workspace, origin) {
    if (workspace.windowProcess) return { alreadyDetached: true };
    if (workspace.detaching) return workspace.detaching;

    workspace.detaching = (async () => {
        const url = `${origin}/?w=${encodeURIComponent(workspace.token)}&mode=detached`;
        const result = await openFloatingWindow(url);
        workspace.windowProcess = result.child;
        workspace.windowCleanup = result.cleanup;
        result.child.once("exit", () => {
            if (workspace.windowProcess !== result.child) return;
            workspace.windowProcess = null;
            const cleanup = workspace.windowCleanup;
            workspace.windowCleanup = null;
            void cleanup?.();
            pruneWorkspace(workspace);
        });
        return { mode: result.mode, browser: result.browser, url };
    })();

    try {
        return await workspace.detaching;
    } finally {
        workspace.detaching = null;
        pruneWorkspace(workspace);
    }
}

export async function attachWorkspace(workspace) {
    if (!workspace.windowProcess) return { alreadyAttached: true };
    try {
        workspace.windowProcess.kill();
    } catch {
        // The window exited between the request and the kill.
    }
    workspace.windowProcess = null;
    const cleanup = workspace.windowCleanup;
    workspace.windowCleanup = null;
    await cleanup?.();
    pruneWorkspace(workspace);
    return { ok: true };
}

export async function disposeWorkspaces() {
    const detaching = [...byToken.values()].map((workspace) => workspace.detaching).filter(Boolean);
    await Promise.allSettled(detaching);
    const cleanups = [];
    for (const workspace of byToken.values()) {
        if (workspace.windowProcess) {
            try {
                workspace.windowProcess.kill();
            } catch {
                // Already gone.
            }
        }
        if (workspace.windowCleanup) cleanups.push(workspace.windowCleanup());
    }
    await Promise.allSettled(cleanups);
    byToken.clear();
    byRoot.clear();
}

export async function ensureServer() {
    if (started) return started;
    started = new Promise((resolve, reject) => {
        const server = createServer(async (req, res) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            const asset = STATIC[url.pathname];
            if (asset) return staticFile(res, asset);

            try {
                const workspace = requireWorkspace(url);
                if (url.pathname === "/api/state" && req.method === "GET") {
                    return json(res, 200, await workspaceState(workspace));
                }
                if (url.pathname === "/api/diff" && req.method === "GET") {
                    const filePath = url.searchParams.get("path");
                    const kind = url.searchParams.get("kind") ?? "working";
                    return json(res, 200, await readDiff(workspace.root, filePath, kind));
                }
                if (url.pathname === "/api/detach" && req.method === "POST") {
                    const origin = `http://127.0.0.1:${server.address().port}`;
                    return json(res, 200, await detachWorkspace(workspace, origin));
                }
                if (url.pathname === "/api/attach" && req.method === "POST") {
                    return json(res, 200, await attachWorkspace(workspace));
                }
                json(res, 404, { error: { code: "not_found", message: "Not found." } });
            } catch (error) {
                errorResponse(res, error);
            }
        });

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            server.on("error", (error) => {
                process.stderr.write(`[floating-changes] HTTP server error: ${error.message}\n`);
            });
            const { port } = server.address();
            resolve({ port, origin: `http://127.0.0.1:${port}` });
        });
    });
    return started;
}
