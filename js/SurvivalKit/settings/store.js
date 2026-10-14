// ============================================================
// SurvivalKit/settings/store.js
// ------------------------------------------------------------
// Global settings store. Persisted in localStorage, merged with
// defaults, notifies subscribers on change.
// v0.1.0 — 2026-10-09
// ============================================================

import { DEFAULTS } from "./defaults.js";

const LS_KEY = "succy:settings";

export class SettingsStore {
    constructor() {
        this._defaults = { ...DEFAULTS };
        this._values = { ...this._defaults };
        this._subscribers = new Set();
        this._load();
    }

    _load() {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw);
            if (saved && typeof saved === "object") {
                this._values = { ...this._defaults, ...saved };
            }
        } catch (_) {}
    }

    _save() {
        try { localStorage.setItem(LS_KEY, JSON.stringify(this._values)); } catch (_) {}
    }

    get(key, def) {
        if (key === undefined) return { ...this._values };
        if (Object.prototype.hasOwnProperty.call(this._values, key)) return this._values[key];
        if (Object.prototype.hasOwnProperty.call(this._defaults, key)) return this._defaults[key];
        return def;
    }

    set(key, value) {
        if (Object.is(this._values[key], value)) return;
        this._values[key] = value;
        this._save();
        this._notify(key, value);
    }

    reset(key) {
        if (key === undefined) {
            this._values = { ...this._defaults };
            this._save();
            this._notify(null, this._values);
            return;
        }
        this._values[key] = this._defaults[key];
        this._save();
        this._notify(key, this._values[key]);
    }

    subscribe(fn) {
        if (typeof fn !== "function") return () => {};
        this._subscribers.add(fn);
        return () => this._subscribers.delete(fn);
    }

    _notify(key, value) {
        for (const fn of this._subscribers) {
            try { fn(key, value); } catch (e) {
                console.warn("[SurvivalKit/settings] subscriber error:", e);
            }
        }
    }
}