import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlanTracker } from "../tracker.mjs";
import { createPlanServer } from "../server.mjs";
import { DEFAULT_VIEW } from "../floating.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "plan-real-window-"));
const errors = [];
const tracker = new PlanTracker(root, { onError: (error) => errors.push(error) });
let server;
async function eventually(check, timeout = 20000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("The real floating window did not reach the expected state.");
}
async function removed(profile) {
    try { await access(profile); return false; } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return true;
    }
}
try {
    await tracker.start();
    const content = "# Native window test\n\nOne read-only plan, shared across surfaces.\n";
    await writeFile(tracker.planPath, content);
    const snapshot = await tracker.capture();
    server = await createPlanServer(tracker, { onError: (error) => errors.push(error) });
    const view = { ...DEFAULT_VIEW, selectedId: snapshot.head, followLatest: false, view: "plan", theme: "dark", resolvedTheme: "dark" };
    await server.floating.detach(view);
    await eventually(() => server.floating.state().connected);
    console.log(`Connected first owned window (PID ${server.floating.window.child.pid}).`);
    server.floating.window.child.on("exit", (code, signal) => console.log(`First window exit: ${code}/${signal}`));
    const firstProfile = server.floating.window.profile;
    assert.equal(server.floating.state().view.selectedId, snapshot.head);
    assert.equal(server.floating.state().view.view, "plan");
    assert.equal(server.floating.state().view.theme, "dark");
    await server.floating.attach();
    assert.equal(server.floating.state().status, "attached");
    await eventually(() => removed(firstProfile));

    await server.floating.detach(view);
    await eventually(() => server.floating.state().connected);
    const external = server.floating.window;
    console.log(`Connected external-close window (PID ${external.child.pid}).`);
    external.child.on("exit", (code, signal) => console.log(`External-close window exit: ${code}/${signal}`));
    await external.close();
    assert.equal(server.floating.state().status, "attached");
    await eventually(() => removed(external.profile));

    await server.floating.detach(view);
    await eventually(() => server.floating.state().connected);
    const finalProfile = server.floating.window.profile;
    console.log(`Connected shutdown window (PID ${server.floating.window.child.pid}).`);
    await server.close();
    server = null;
    await eventually(() => removed(finalProfile));
    assert.equal(await readFile(tracker.planPath, "utf8"), content);
    assert.equal((await tracker.refresh()).head, snapshot.head);
    assert.deepEqual(errors, []);
    console.log("Passed real OS-window smoke: renderer connected, selected snapshot/view/theme retained, pop-in/manual-exit/shutdown observed, profiles removed, native plan unchanged.");
} catch (error) {
    const owned = server?.floating.window;
    console.error({
        fixture: root, error: error.message, ownedPid: owned?.child.pid,
        exitCode: owned?.child.exitCode, signalCode: owned?.child.signalCode,
        killed: owned?.child.killed, profile: owned?.profile,
    });
    throw error;
} finally {
    try {
        await server?.close();
    } finally {
        await tracker.dispose();
        await rm(root, { recursive: true, force: true });
    }
}
