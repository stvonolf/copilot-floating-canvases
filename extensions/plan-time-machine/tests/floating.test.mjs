import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VIEW, FloatingPlan, validateView } from "../floating.mjs";
import { openFloatingWindow } from "../detach.mjs";
import { createPlanServer } from "../server.mjs";

function deferred() {
    let resolve, reject;
    const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
    return { promise, resolve, reject };
}

function fakeWindow() {
    const exit = deferred();
    let calls = 0;
    return {
        closed: exit.promise,
        exit: exit.resolve,
        close: async () => { calls++; exit.resolve({ code: 0, signal: null }); },
        get closeCalls() { return calls; },
    };
}

const selectedView = {
    ...DEFAULT_VIEW, selectedId: "a".repeat(40), followLatest: false,
    view: "plan", theme: "dark", resolvedTheme: "dark", scrollY: 350, historyOpen: true,
};

test("view handoff is bounded, strictly typed, and does not accept arbitrary fields", () => {
    assert.deepEqual(validateView(selectedView), selectedView);
    assert.notEqual(validateView(selectedView), selectedView);
    for (const value of [
        null, [], {}, { ...selectedView, url: "https://example.invalid" },
        { ...selectedView, selectedId: "../../plan.md" },
        { ...selectedView, scrollY: -1 }, { ...selectedView, scrollY: Infinity },
        { ...selectedView, scrollY: 10000001 }, { ...selectedView, theme: "unsafe" },
        { ...selectedView, followLatest: "false" }, { ...selectedView, constructor: {} },
    ]) {
        assert.throws(() => validateView(value), { code: "invalid_window_view" });
    }
});

test("concurrent detach opens one managed window and attach preserves its last view", async () => {
    const opening = deferred();
    const window = fakeWindow();
    let launches = 0;
    let url;
    let idleCount = 0;
    const controller = new FloatingPlan({
        launch: (value) => { launches++; url = value; return opening.promise; },
        urlFor: (id) => `http://127.0.0.1:1234/?window=${id}`,
        onIdle: () => { idleCount++; },
    });
    const first = controller.detach(selectedView);
    const second = controller.detach(DEFAULT_VIEW);
    assert.equal(first, second);
    assert.equal(launches, 1);
    assert.equal(controller.state().status, "opening");
    assert.ok(url.includes(controller.state().id));
    opening.resolve(window);
    const detached = await first;
    assert.equal(detached.status, "detached");
    assert.deepEqual(detached.view, selectedView);
    assert.equal(controller.active, true);
    const changed = { ...selectedView, view: "diff", scrollY: 120 };
    controller.update(detached.id, changed);
    assert.equal(controller.state().connected, true);
    assert.throws(() => controller.update("another-window", DEFAULT_VIEW), { code: "stale_window" });
    await assert.rejects(controller.attach("another-window"), { code: "stale_window" });
    await Promise.all([controller.attach(detached.id), controller.attach(detached.id)]);
    assert.equal(window.closeCalls, 1);
    assert.equal(controller.state().status, "attached");
    assert.deepEqual(controller.state().view, changed);
    assert.equal(idleCount, 1);
    await controller.dispose();
});

test("natural close returns to panel and reopening rejects updates from the old window", async () => {
    const windows = [];
    const controller = new FloatingPlan({
        launch: async () => { const window = fakeWindow(); windows.push(window); return window; },
        urlFor: (id) => `http://127.0.0.1:1234/?window=${id}`,
    });
    const first = await controller.detach(selectedView);
    controller.update(first.id, selectedView);
    windows[0].exit({ code: 0 });
    await windows[0].closed;
    assert.equal(controller.state().status, "attached");
    assert.equal(controller.state().error, null);
    const second = await controller.detach();
    assert.notEqual(first.id, second.id);
    assert.throws(() => controller.update(first.id, selectedView), { code: "stale_window" });
    assert.equal(windows.length, 2);
    await controller.dispose();
    assert.equal(windows[1].closeCalls, 1);
    assert.equal(controller.state().status, "attached");
    await assert.rejects(controller.detach(), { code: "window_unavailable" });
});

test("failed and immediately exited launches do not leave the panel detached", async () => {
    let fail = true;
    const controller = new FloatingPlan({
        launch: async () => {
            if (fail) throw new Error("launch failed");
            const window = fakeWindow();
            window.exit({ code: 1 });
            return window;
        },
        urlFor: () => "http://127.0.0.1:1234/",
    });
    await assert.rejects(controller.detach(), /launch failed/);
    assert.equal(controller.state().status, "attached");
    assert.match(controller.state().error, /launch failed/);
    fail = false;
    await controller.detach();
    await Promise.resolve();
    assert.equal(controller.state().status, "attached");
    assert.match(controller.state().error, /before connecting/);
    await controller.dispose();
});

test("shutdown and attach during launch wait for and close the exact newly opened window", async () => {
    const opening = deferred();
    const window = fakeWindow();
    const controller = new FloatingPlan({
        launch: () => opening.promise,
        urlFor: () => "http://127.0.0.1:1234/",
    });
    const launching = controller.detach();
    const shutdown = controller.dispose();
    opening.resolve(window);
    await Promise.all([launching, shutdown]);
    assert.equal(window.closeCalls, 1);
    assert.equal(controller.state().status, "attached");
});

test("close failures remain visible and can be retried without opening duplicate windows", async () => {
    const window = fakeWindow();
    const close = window.close;
    window.close = async () => { throw new Error("close failed"); };
    const controller = new FloatingPlan({
        launch: async () => window,
        urlFor: () => "http://127.0.0.1:1234/",
    });
    const opened = await controller.detach();
    controller.update(opened.id, selectedView);
    await assert.rejects(controller.attach(), /close failed/);
    assert.equal(controller.state().status, "detached");
    assert.match(controller.state().error, /close failed/);
    window.close = close;
    await controller.attach();
    assert.equal(controller.state().status, "attached");
    await controller.dispose();
});

test("launcher explicitly rejects unsupported browsers and non-loopback URLs", async () => {
    await assert.rejects(openFloatingWindow("http://127.0.0.1:1234/", { browserPath: null }), { code: "browser_unavailable" });
    await assert.rejects(openFloatingWindow("https://example.invalid", { browserPath: null }), { code: "invalid_window_url" });
    await assert.rejects(openFloatingWindow("http://127.0.0.1:1234/", {
        browserPath: process.platform === "win32" ? "C:\\missing-plan-test-browser.exe" : "/missing-plan-test-browser",
    }), { code: "window_launch_failed" });
});

test("HTTP window controls require capability, same-origin JSON, and current window ID", async (t) => {
    let launches = 0;
    let openedUrl;
    const window = fakeWindow();
    const tracker = {
        refresh: async () => ({ version: "plan-state-unchanged" }),
    };
    const server = await createPlanServer(tracker, {
        onError: () => {},
        launchWindow: async (url) => { launches++; openedUrl = url; return window; },
    });
    t.after(() => server.close());
    const headers = { "X-Plan-Token": server.token, Origin: server.origin, "Content-Type": "application/json" };
    const post = (route, body, override = headers) => fetch(`${server.origin}/api/${route}`, {
        method: "POST", headers: override, body: JSON.stringify(body),
    });
    assert.equal((await post("detach", {}, { Origin: server.origin, "Content-Type": "application/json" })).status, 401);
    assert.equal((await post("detach", {}, { ...headers, Origin: "https://example.invalid" })).status, 403);
    assert.equal((await post("detach", {}, { "X-Plan-Token": server.token, "Content-Type": "application/json" })).status, 403);
    assert.equal((await post("detach", { url: "https://example.invalid" })).status, 400);
    assert.equal((await post("detach", { view: { ...selectedView, selectedId: "bad" } })).status, 400);
    assert.equal(launches, 0);
    const response = await post("detach", { view: selectedView });
    assert.equal(response.status, 200);
    const detached = await response.json();
    assert.equal(detached.status, "detached");
    assert.match(openedUrl, /surface=floating/);
    assert.ok(openedUrl.endsWith(`#token=${server.token}`));
    assert.equal(new URL(openedUrl).searchParams.has("token"), false);
    assert.equal(JSON.stringify(detached).includes(server.token), false);
    await post("detach", {});
    assert.equal(launches, 1);
    assert.equal((await post("window-view", { windowId: detached.id })).status, 400);
    assert.equal((await post("window-view", { windowId: "stale", view: selectedView })).status, 409);
    const updated = { ...selectedView, scrollY: 42 };
    assert.equal((await post("window-view", { windowId: detached.id, view: updated })).status, 200);
    const state = await (await fetch(`${server.origin}/api/state`, { headers })).json();
    assert.equal(state.floating.view.scrollY, 42);
    assert.equal(state.version, "plan-state-unchanged");
    assert.equal((await post("attach", { windowId: "stale" })).status, 409);
    assert.equal((await post("attach", { windowId: detached.id })).status, 200);
    assert.equal(window.closeCalls, 1);
    assert.equal(server.floating.active, false);
});
