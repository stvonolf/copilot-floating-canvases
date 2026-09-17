import process from "node:process";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

import { GitError, readDiff } from "./git.mjs";
import {
    attachWorkspace,
    detachWorkspace,
    disposeWorkspaces,
    ensureServer,
    registerWorkspace,
    releaseWorkspace,
    retainWorkspace,
    workspaceState,
    reviewStore,
} from "./server.mjs";

const instances = new Map();

function canvasError(error) {
    if (error instanceof CanvasError) return error;
    if (error instanceof GitError) return new CanvasError(error.code, error.message);
    return new CanvasError("changes_failed", String(error.message ?? error));
}

function workspaceFor(instanceId) {
    const workspace = instances.get(instanceId);
    if (!workspace) throw new CanvasError("workspace_not_open", "Open the Changes canvas before using this action.");
    return workspace;
}

const changesCanvas = createCanvas({
    id: "floating-changes",
    displayName: "Floating changes",
    description: "Git changes and Since You Looked review deltas with persistent feedback, in a panel or floating window.",
    inputSchema: {
        type: "object",
        properties: {
            cwd: {
                type: "string",
                description: "A path inside the Git repository. Defaults to the session working directory.",
            },
            detached: {
                type: "boolean",
                description: "Open directly in a floating window.",
            },
            view: {
                type: "string", enum: ["git", "review"],
                description: "Open the normal Git view or Since You Looked review mode.",
            },
        },
        additionalProperties: false,
    },
    actions: [
        {
            name: "get_status",
            description: "Read the current staged, unstaged, untracked, and conflicted files.",
            handler: async (ctx) => {
                try {
                    return await workspaceState(workspaceFor(ctx.instanceId));
                } catch (error) {
                    throw canvasError(error);
                }
            },
        },
        {
            name: "get_diff",
            description: "Read the unified diff for one changed file.",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Repository-relative file path." },
                    kind: {
                        type: "string",
                        enum: ["working", "staged", "untracked", "conflict"],
                        description: "Which version of the change to show.",
                    },
                },
                required: ["path", "kind"],
                additionalProperties: false,
            },
            handler: async (ctx) => {
                try {
                    const workspace = workspaceFor(ctx.instanceId);
                    return await readDiff(workspace.root, ctx.input.path, ctx.input.kind);
                } catch (error) {
                    throw canvasError(error);
                }
            },
        },
        {
            name: "get_review_status",
            description: "Read differences since the user's last review checkpoint and persistent file feedback.",
            handler: async (ctx) => {
                try { return await (await reviewStore(workspaceFor(ctx.instanceId))).state(); }
                catch (error) { throw canvasError(error); }
            },
        },
        {
            name: "get_review_diff",
            description: "Read a file's exact diff in a review view returned by get_review_status.",
            inputSchema: {
                type: "object", properties: { path: { type: "string" }, viewId: { type: "string" } },
                required: ["path", "viewId"], additionalProperties: false,
            },
            handler: async (ctx) => {
                try { return await (await reviewStore(workspaceFor(ctx.instanceId))).diff(ctx.input.path, ctx.input.viewId); }
                catch (error) { throw canvasError(error); }
            },
        },
        {
            name: "detach",
            description: "Move the Changes panel into a floating OS window.",
            inputSchema: {
                type: "object", properties: { view: { type: "string", enum: ["git", "review"] } },
                additionalProperties: false,
            },
            handler: async (ctx) => {
                try {
                    const { origin } = await ensureServer();
                    return await detachWorkspace(workspaceFor(ctx.instanceId), origin, ctx.input?.view ?? "git");
                } catch (error) {
                    throw canvasError(error);
                }
            },
        },
        {
            name: "attach",
            description: "Close the floating window and bring Changes back into the panel.",
            handler: async (ctx) => await attachWorkspace(workspaceFor(ctx.instanceId)),
        },
    ],
    open: async (ctx) => {
        try {
            await initialized;
            const cwd = ctx.input?.cwd ?? ctx.session?.workingDirectory ?? process.cwd();
            const workspace = await registerWorkspace(cwd, { sessionWorkspace: session.workspacePath });
            const { origin } = await ensureServer();
            const previous = instances.get(ctx.instanceId);
            if (previous !== workspace) {
                if (previous) releaseWorkspace(previous);
                retainWorkspace(workspace);
            }
            instances.set(ctx.instanceId, workspace);

            if (ctx.input?.detached && !workspace.windowProcess) await detachWorkspace(workspace, origin, ctx.input?.view ?? "git");

            return {
                title: "Changes",
                status: workspace.root,
                url: `${origin}/?w=${encodeURIComponent(workspace.token)}&mode=panel&view=${ctx.input?.view ?? "git"}`,
            };
        } catch (error) {
            throw canvasError(error);
        }
    },
    onClose: (ctx) => {
        const workspace = instances.get(ctx.instanceId);
        instances.delete(ctx.instanceId);
        if (workspace) releaseWorkspace(workspace);
    },
});

let session;
const initialized = joinSession({ canvases: [changesCanvas] }).then((joined) => { session = joined; });
await initialized;
const { port } = await ensureServer();
try {
    await session.log(`floating-changes ready on 127.0.0.1:${port}`, { level: "info", ephemeral: true });
} catch {
    // A diagnostic must never take down the extension.
}

for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, async () => {
        await disposeWorkspaces();
        process.exit(0);
    });
}
