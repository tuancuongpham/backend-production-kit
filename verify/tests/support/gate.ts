// Holds code at a point the test chooses, the way the real world holds it: a payment provider that takes its
// time, a model that is still generating. The test learns when the code got there, acts (closes the tab, starts a
// deploy, sends the duplicate), then lets it go on.

export class Gate {
  #open!: () => void;
  #arrive!: () => void;
  /** Resolves once open() is called. */
  readonly opened = new Promise<void>((resolve) => (this.#open = resolve));
  /** Resolves when code first reaches pass(): it is now waiting at the gate. */
  readonly reached = new Promise<void>((resolve) => (this.#arrive = resolve));

  /** Called by the code under test. Waits until the test opens the gate; once open, returns at once. */
  async pass(): Promise<void> {
    this.#arrive();
    await this.opened;
  }

  open(): void {
    this.#open();
  }
}
