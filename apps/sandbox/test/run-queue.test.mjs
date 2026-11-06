import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RunQueue } from "../src/run-queue.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function track(promise) {
  const state = { done: false, error: undefined };
  promise.then(() => { state.done = true; }, (error) => { state.error = error; });
  return state;
}

describe("RunQueue", () => {
  test("starts runs up to the concurrency and queues the rest in order", async () => {
    const queue = new RunQueue({ concurrency: 2, perOwner: 2 });
    const runs = ["a", "b", "c", "d"].map((owner) => track(queue.acquire(owner)));
    await settle();
    assert.deepEqual(runs.map((r) => r.done), [true, true, false, false]);
    queue.release("a");
    await settle();
    assert.deepEqual(runs.map((r) => r.done), [true, true, true, false]);
  });

  test("keeps one account to its share and lets others pass it in line", async () => {
    const queue = new RunQueue({ concurrency: 4, perOwner: 2 });
    const busy = Array.from({ length: 4 }, () => track(queue.acquire("busy")));
    const other = track(queue.acquire("other"));
    await settle();
    assert.deepEqual(busy.map((r) => r.done), [true, true, false, false]);
    assert.equal(other.done, true, "a second account starts although the first one is waiting");
    queue.release("busy");
    await settle();
    assert.deepEqual(busy.map((r) => r.done), [true, true, true, false]);
  });

  test("refuses with 429 once the account's place in line is used up", async () => {
    const queue = new RunQueue({ concurrency: 2, perOwner: 1 });
    await queue.acquire("busy");
    for (let i = 0; i < 8; i++) queue.acquire("busy");
    await assert.rejects(queue.acquire("busy"), (error) => error.status === 429 && /this account/.test(error.message));
    await queue.acquire("other");
  });

  test("refuses with 429 once the whole line is full", async () => {
    const queue = new RunQueue({ concurrency: 1, perOwner: 1 });
    await queue.acquire("a");
    for (let i = 0; i < 8; i++) queue.acquire(`owner-${i}`);
    await assert.rejects(queue.acquire("late"), (error) => error.status === 429 && /busy/.test(error.message));
  });

  test("never gives one account more than the concurrency", () => {
    assert.equal(new RunQueue({ concurrency: 2, perOwner: 10 }).perOwner, 2);
  });
});
