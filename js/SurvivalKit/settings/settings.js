// ============================================================
// SurvivalKit/settings/settings.js
// ------------------------------------------------------------
// Settings facade. Composes store + css-vars.
// v0.1.0 — 2026-10-09
// ============================================================

import { SettingsStore } from "./store.js";
import { applyCssVars, removeCssVars, readCssVar } from "./css-vars.js";

export class Settings {
    constructor() {
        this.store = new SettingsStore();
    }

    get(key, def) { return this.store.get(key, def); }
    set(key, value) { return this.store.set(key, value); }
    reset(key) { return this.store.reset(key); }
    subscribe(fn) { return this.store.subscribe(fn); }

    applyCssVars(vars, target) { return applyCssVars(vars, target); }
    removeCssVars(names, target) { return removeCssVars(names, target); }
    readCssVar(name, target) { return readCssVar(name, target); }
}