// ============================================================
// NodeStructure/util/tracker.js
// ------------------------------------------------------------
// Bag: everything the builder creates OUTSIDE the kit channels
// (listeners, observers, timers, elements in the body) goes through here and
// is released in dispose(). The kit can't see it, so keeping
// count is on us: Bag.stats() makes it verifiable. We clean up after ourselves.
// ============================================================

const LIVE = new Set();
const TOTALS = { created: 0, disposed: 0 };

export class Bag {
    constructor(label = "bag") {
        this.label = label;
        this._items = [];
        this.closed = false;
        this.counts = { listeners: 0, timers: 0, observers: 0, other: 0 };
        LIVE.add(this);
        TOTALS.created++;
    }

    get size() { return this._items.length; }

    // fn() runs on dispose. If the bag is already closed, right away.
    add(fn, kind = "other") {
        if (typeof fn !== "function") return fn;
        if (this.closed) { try { fn(); } catch (_) {} return fn; }
        this._items.push(fn);
        this.counts[kind] = (this.counts[kind] || 0) + 1;
        return fn;
    }

    remove(fn) {
        const i = this._items.indexOf(fn);
        if (i >= 0) this._items.splice(i, 1);
    }

    listen(target, ev, fn, opts) {
        if (!target || this.closed) return () => {};
        target.addEventListener(ev, fn, opts);
        const off = () => { try { target.removeEventListener(ev, fn, opts); } catch (_) {} };
        this.add(off, "listeners");
        return off;
    }

    timeout(fn, ms) {
        if (this.closed) return 0;
        const id = setTimeout(() => {
            this.remove(cancel);
            try { fn(); } catch (e) { console.warn(`[NodeStructure/${this.label}] timeout error:`, e); }
        }, ms);
        const cancel = () => clearTimeout(id);
        this.add(cancel, "timers");
        return id;
    }

    interval(fn, ms) {
        if (this.closed) return 0;
        const id = setInterval(() => {
            try { fn(); } catch (e) { console.warn(`[NodeStructure/${this.label}] interval error:`, e); }
        }, ms);
        this.add(() => clearInterval(id), "timers");
        return id;
    }

    // tracked rAF: returns cancel()
    raf(fn) {
        if (this.closed) return () => {};
        const id = requestAnimationFrame(() => {
            this.remove(cancel);
            try { fn(); } catch (e) { console.warn(`[NodeStructure/${this.label}] raf error:`, e); }
        });
        const cancel = () => cancelAnimationFrame(id);
        this.add(cancel, "timers");
        return cancel;
    }

    observer(obs) {
        if (obs?.disconnect) this.add(() => obs.disconnect(), "observers");
        return obs;
    }

    dispose() {
        if (this.closed) return 0;
        this.closed = true;
        const items = this._items.splice(0).reverse();
        for (const fn of items) {
            try { fn(); } catch (e) { console.warn(`[NodeStructure/${this.label}] dispose error:`, e); }
        }
        LIVE.delete(this);
        TOTALS.disposed++;
        return items.length;
    }

    static stats() {
        let items = 0;
        for (const b of LIVE) items += b.size;
        return { liveBags: LIVE.size, liveItems: items, created: TOTALS.created, disposed: TOTALS.disposed };
    }

    static live() { return [...LIVE]; }
}
