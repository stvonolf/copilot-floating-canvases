import { randomUUID } from "node:crypto";
import { PlanError } from "./history.mjs";

export const DEFAULT_VIEW = Object.freeze({
    selectedId: null, followLatest: true, view: "diff", showContext: false,
    theme: "system", resolvedTheme: "light", scrollY: 0, historyOpen: false,
});

export function validateView(value = DEFAULT_VIEW) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_VIEW, key)) ||
        !(value.selectedId === null || value.selectedId === "working" || /^[a-f0-9]{40}$/.test(value.selectedId)) ||
        typeof value.followLatest !== "boolean" || !["diff", "plan"].includes(value.view) ||
        typeof value.showContext !== "boolean" || !["light", "dark", "system"].includes(value.theme) ||
        !["light", "dark"].includes(value.resolvedTheme) || typeof value.historyOpen !== "boolean" ||
        !Number.isFinite(value.scrollY) || value.scrollY < 0 || value.scrollY > 10000000) {
        throw new PlanError("invalid_window_view", "The floating-window view settings are invalid.");
    }
    return { ...value };
}

export class FloatingPlan {
    constructor({ launch, urlFor, onError = console.error, onIdle = () => {} }) {
        this.launch = launch;
        this.urlFor = urlFor;
        this.onError = onError;
        this.onIdle = onIdle;
        this.status = "attached";
        this.id = null;
        this.view = null;
        this.version = 0;
        this.error = null;
        this.connected = false;
        this.window = null;
        this.opening = null;
        this.closing = null;
        this.disposed = false;
    }

    get active() {
        return this.status !== "attached";
    }

    state() {
        return {
            status: this.status, id: this.id, view: this.view, version: this.version,
            error: this.error, connected: this.connected,
        };
    }

    changed() {
        this.version++;
    }

    idle() {
        this.status = "attached";
        this.id = null;
        this.window = null;
        this.connected = false;
        this.changed();
        Promise.resolve().then(() => this.onIdle()).catch(this.onError);
    }

    detach(view = DEFAULT_VIEW) {
        if (this.disposed) return Promise.reject(new PlanError("window_unavailable", "The canvas provider is shutting down."));
        if (this.closing) return Promise.reject(new PlanError("window_busy", "The previous window is still closing. Retry shortly."));
        if (this.opening) return this.opening;
        if (this.window) return Promise.resolve(this.state());
        this.view = validateView(view);
        this.id = randomUUID();
        this.status = "opening";
        this.error = null;
        this.connected = false;
        this.changed();
        const id = this.id;
        this.opening = (async () => {
            try {
                const window = await this.launch(this.urlFor(id));
                this.window = window;
                this.status = "detached";
                this.changed();
                void window.closed.then(() => {
                    if (this.id !== id || this.window !== window) return;
                    if (!this.connected && !this.closing && !this.disposed) {
                        this.error = "The floating window closed before connecting. The plan is still available here.";
                    }
                    this.idle();
                }).catch(this.onError);
                return this.state();
            } catch (error) {
                this.error = String(error.message ?? error);
                this.idle();
                throw error;
            } finally {
                this.opening = null;
            }
        })();
        return this.opening;
    }

    update(id, view) {
        if (id !== this.id || !this.active || this.closing || this.disposed) {
            throw new PlanError("stale_window", "This floating window is no longer active.");
        }
        const next = validateView(view);
        const changed = !this.connected || JSON.stringify(next) !== JSON.stringify(this.view);
        this.view = next;
        this.connected = true;
        if (changed) this.changed();
        return this.state();
    }

    attach(id = this.id, view) {
        if (id !== null && id !== this.id) return Promise.reject(new PlanError("stale_window", "This floating window is no longer active."));
        if (view !== undefined) this.view = validateView(view);
        if (this.closing) return this.closing;
        const operation = async () => {
            if (this.opening) await this.opening;
            if (!this.window) return this.state();
            this.status = "closing";
            this.error = null;
            this.changed();
            const current = this.window;
            try {
                await current.close();
                if (this.window === current) this.idle();
                return this.state();
            } catch (error) {
                this.error = String(error.message ?? error);
                if (this.window === current) this.status = "detached";
                this.changed();
                throw error;
            }
        };
        this.closing = operation().finally(() => { this.closing = null; });
        return this.closing;
    }

    async dispose() {
        this.disposed = true;
        await this.attach();
    }
}
