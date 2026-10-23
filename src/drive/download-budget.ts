/**
 * drive.download-budget.ts — byte-weighted admission control for downloads.
 *
 * Downloads are buffered whole (client.downloadFileBuffer) and the parsers then
 * build their own structures next to the buffer, so a count of workers is the
 * wrong bound: 4 workers x 290 MiB is ~1.1 GiB of buffers before any parsing,
 * and a transfer briefly holds ~2x its size (the chunks plus the concatenated
 * Buffer). This class bounds the BYTES in flight instead:
 *
 *   - light file (known size below `heavyBytes`): reserves its own size, and
 *     starts once nothing heavy is running and the reservations still fit in
 *     `capacityBytes`;
 *   - heavy file (size at or above `heavyBytes`, or unknown): EXCLUSIVE. It
 *     waits until nothing else is in flight, then holds the whole budget until
 *     it is released — nothing else starts meanwhile. An unknown size has to
 *     count as heavy: it is exactly the case where the bound can't be checked.
 *
 * Admission is strict FIFO. A waiter starts only when everyone queued before it
 * has started, so a heavy file at the head of the queue can't be starved by a
 * stream of light ones. The cost is that a light file queued behind a heavy one
 * waits for it even if it would fit; downloads are long, so that is cheap.
 *
 * Pure and self-contained (no config, no I/O, no globals) so it can be unit
 * tested with fake downloads; download.ts owns the process-wide instance.
 * The release function returned by acquire() MUST be called exactly when the
 * memory is no longer held (it is idempotent); never acquire again while
 * holding a reservation — a heavy holder waiting on the budget deadlocks.
 */

export interface ByteBudgetOptions {
  /** Most bytes that may be reserved at once. */
  capacityBytes: number;
  /** A file of at least this size (or of unknown size) runs alone. */
  heavyBytes: number;
}

interface Waiter {
  heavy: boolean;
  /** Bytes charged while held; a heavy holder is charged the whole capacity. */
  charge: number;
  start: () => void;
}

export class ByteBudget {
  readonly capacityBytes: number;
  readonly heavyBytes: number;

  private reserved = 0;
  private holders = 0;
  private heavyHeld = false;
  private peakReserved = 0;
  private peakHolders = 0;
  private readonly waiting: Waiter[] = [];

  constructor({ capacityBytes, heavyBytes }: ByteBudgetOptions) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 1) {
      throw new RangeError(
        `ByteBudget: capacityBytes must be an integer >= 1 (got ${capacityBytes})`,
      );
    }
    if (!Number.isSafeInteger(heavyBytes) || heavyBytes < 1) {
      throw new RangeError(`ByteBudget: heavyBytes must be an integer >= 1 (got ${heavyBytes})`);
    }
    // A light file (below heavyBytes) must be able to fit in the capacity, or
    // it would wait forever.
    if (heavyBytes > capacityBytes) {
      throw new RangeError(
        `ByteBudget: heavyBytes (${heavyBytes}) must not exceed capacityBytes (${capacityBytes})`,
      );
    }
    this.capacityBytes = capacityBytes;
    this.heavyBytes = heavyBytes;
  }

  /** Bytes currently reserved (a heavy holder counts as the whole capacity). */
  get inFlightBytes(): number {
    return this.reserved;
  }

  /** Reservations currently held. */
  get active(): number {
    return this.holders;
  }

  /** Callers waiting for admission. */
  get queued(): number {
    return this.waiting.length;
  }

  /** Highest `inFlightBytes` seen since construction. */
  get highWaterBytes(): number {
    return this.peakReserved;
  }

  /** Highest `active` seen since construction. */
  get highWaterActive(): number {
    return this.peakHolders;
  }

  /**
   * Wait for admission, then reserve. `bytes` is the size from metadata taken
   * BEFORE the fetch; null (or anything not a finite size >= 0) is unknown and
   * counts as heavy. Resolves with the release function.
   */
  acquire(bytes: number | null): Promise<() => void> {
    const { heavy, charge } = this.classify(bytes);
    return new Promise<() => void>((resolve) => {
      this.waiting.push({ heavy, charge, start: () => resolve(this.releaser(heavy, charge)) });
      this.pump();
    });
  }

  private classify(bytes: number | null): { heavy: boolean; charge: number } {
    if (bytes === null || !Number.isFinite(bytes) || bytes < 0 || bytes >= this.heavyBytes) {
      return { heavy: true, charge: this.capacityBytes };
    }
    return { heavy: false, charge: bytes };
  }

  private canStart(w: Waiter): boolean {
    if (w.heavy) return this.holders === 0;
    return !this.heavyHeld && this.reserved + w.charge <= this.capacityBytes;
  }

  /** Admit from the head of the queue for as long as the head fits. */
  private pump(): void {
    for (;;) {
      const head: Waiter | undefined = this.waiting[0];
      // Strict FIFO: if the head can't start yet, nobody behind it may.
      if (!head || !this.canStart(head)) return;
      this.waiting.shift();
      this.holders++;
      this.reserved += head.charge;
      if (head.heavy) this.heavyHeld = true;
      this.peakReserved = Math.max(this.peakReserved, this.reserved);
      this.peakHolders = Math.max(this.peakHolders, this.holders);
      head.start();
    }
  }

  private releaser(heavy: boolean, charge: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders--;
      this.reserved -= charge;
      if (heavy) this.heavyHeld = false;
      this.pump();
    };
  }
}
