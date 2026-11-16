/**
 * Decides when a run may start. At most `concurrency` scripts run at once, and one owner (an account) holds at most
 * `perOwner` of those slots and `perOwner * 8` places in line, so a single account cannot keep everyone else waiting.
 * Waiting runs start in arrival order, skipping owners already at their limit.
 */
export class RunQueue {
  constructor({ concurrency, perOwner }) {
    this.concurrency = concurrency;
    this.perOwner = Math.min(perOwner, concurrency);
    this.queueLimit = concurrency * 8;
    this.ownerQueueLimit = this.perOwner * 8;
    this.active = 0;
    this.running = new Map();
    this.waiting = [];
  }

  #count(map, owner) { return map.get(owner) ?? 0; }

  #canStart(owner) { return this.active < this.concurrency && this.#count(this.running, owner) < this.perOwner; }

  #start(owner) {
    this.active++;
    this.running.set(owner, this.#count(this.running, owner) + 1);
  }

  /**
   * Resolves when the run may start; rejects with status 429 when the line is full for everyone or for this owner.
   * Aborting `signal` while the run waits (the caller went away) takes it out of line, so it never starts.
   */
  acquire(owner = "", signal) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("Caller went away"), { status: 499 }));
    if (this.#canStart(owner)) { this.#start(owner); return Promise.resolve(); }
    if (this.waiting.length >= this.queueLimit) return Promise.reject(Object.assign(new Error("Sandbox is busy"), { status: 429 }));
    if (this.waiting.filter((entry) => entry.owner === owner).length >= this.ownerQueueLimit) {
      return Promise.reject(Object.assign(new Error("Too many scripts waiting for this account"), { status: 429 }));
    }
    return new Promise((resolve, reject) => {
      const entry = { owner, resolve };
      this.waiting.push(entry);
      signal?.addEventListener("abort", () => {
        const index = this.waiting.indexOf(entry);
        if (index === -1) return;
        this.waiting.splice(index, 1);
        reject(Object.assign(new Error("Caller went away"), { status: 499 }));
      }, { once: true });
    });
  }

  release(owner = "") {
    this.active--;
    const left = this.#count(this.running, owner) - 1;
    if (left > 0) this.running.set(owner, left); else this.running.delete(owner);
    while (this.active < this.concurrency) {
      const index = this.waiting.findIndex((entry) => this.#canStart(entry.owner));
      if (index === -1) break;
      const [next] = this.waiting.splice(index, 1);
      this.#start(next.owner);
      next.resolve();
    }
  }
}
