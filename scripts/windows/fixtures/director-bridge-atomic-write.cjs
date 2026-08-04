"use strict";

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const RETRY_WINDOW_MS = 2_000;
const RETRY_DELAY_MS = 10;

function createAtomicWriter({ filesystem, clock, waiter, identity }) {
  return function atomicWrite(target, value) {
    const temporary = `${target}.tmp-${identity.pid}-${identity.randomUUID()}`;
    let published = false;
    try {
      filesystem.writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      const deadline = clock.now() + RETRY_WINDOW_MS;
      for (;;) {
        try {
          filesystem.renameSync(temporary, target);
          published = true;
          return;
        } catch (error) {
          const code = error && typeof error === "object" ? error.code : undefined;
          if (!TRANSIENT_RENAME_CODES.has(code) || clock.now() >= deadline) throw error;
          waiter.wait(RETRY_DELAY_MS);
        }
      }
    } finally {
      if (!published) {
        try { filesystem.rmSync(temporary, { force: true }); } catch { /* preserve the original failure */ }
      }
    }
  };
}

module.exports = { createAtomicWriter };
