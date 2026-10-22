import type { ProviderConfig } from './config.js';
import { parseCommandOutput, runCommand, type CommandRunner } from './command.js';
import { DynamicApiKeyError } from './errors.js';

export interface Lease {
  readonly key: string;
  readonly generation: number;
  readonly expiresAt: number;
}
export interface ManagerOptions {
  readonly now?: () => number;
  readonly run?: CommandRunner;
}
interface State {
  readonly config: ProviderConfig;
  generation: number;
  lease: Lease | undefined;
  flight: Promise<Lease> | undefined;
  controller: AbortController | undefined;
}

/** One location-scoped instance; secrets never enter provider settings or storage. */
export class KeyManager {
  readonly #states = new Map<string, State>();
  readonly #now: () => number;
  readonly #run: CommandRunner;
  #disposed = false;
  #disposal: Promise<void> | undefined;

  constructor(configs: ReadonlyMap<string, ProviderConfig>, options: ManagerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#run = options.run ?? runCommand;
    for (const [id, config] of configs) this.#states.set(id, { config, generation: 0, lease: undefined, flight: undefined, controller: undefined });
  }

  async ensureFresh(providerID: string): Promise<Lease> {
    if (this.#disposed) throw new DynamicApiKeyError('disposed');
    const state = this.#states.get(providerID);
    if (!state) throw new DynamicApiKeyError('provider');
    if (state.flight) return state.flight;
    if (state.lease && this.isCurrent(providerID, state.lease)) return state.lease;
    // Invalidate BEFORE starting a refresh. Failure must not fall back even if
    // the old key still has wall-clock time remaining inside the ahead window.
    state.lease = undefined;
    const controller = new AbortController();
    state.controller = controller;
    const startedAt = this.#now();
    const flight = Promise.resolve().then(async () => {
      if (this.#disposed || controller.signal.aborted) throw new DynamicApiKeyError('disposed');
      try {
        const output = await this.#run(state.config, controller.signal);
        if (this.#disposed || controller.signal.aborted) throw new DynamicApiKeyError('disposed');
        const issued = parseCommandOutput(output, state.config, startedAt, this.#now());
        const lease = Object.freeze({ ...issued, generation: ++state.generation });
        state.lease = lease;
        return lease;
      } catch (error) {
        state.lease = undefined;
        if (error instanceof DynamicApiKeyError) throw new DynamicApiKeyError(error.code);
        throw new DynamicApiKeyError('command');
      }
    }).finally(() => {
      state.flight = undefined;
      state.controller = undefined;
    });
    state.flight = flight;
    return flight;
  }

  isCurrent(providerID: string, lease: Lease): boolean {
    const state = this.#states.get(providerID);
    const now = this.#now();
    return !this.#disposed && !!state?.lease && Number.isFinite(now)
      && state.lease.generation === lease.generation && state.lease.key === lease.key
      && now < state.lease.expiresAt - state.config.refreshAheadMs;
  }

  assertCurrent(providerID: string, lease: Lease): void {
    if (!this.isCurrent(providerID, lease)) throw new DynamicApiKeyError('lease');
  }

  invalidate(providerID: string, used: Pick<Lease, 'generation' | 'key'>): void {
    const state = this.#states.get(providerID);
    if (state?.lease?.generation === used.generation && state.lease.key === used.key) state.lease = undefined;
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    const pending: Promise<Lease>[] = [];
    for (const state of this.#states.values()) {
      state.lease = undefined;
      state.controller?.abort();
      if (state.flight) pending.push(state.flight);
    }
    this.#disposal = Promise.allSettled(pending).then(() => { this.#states.clear(); });
    return this.#disposal;
  }
}
