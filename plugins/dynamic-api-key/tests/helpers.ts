import { parseConfig, type ProviderConfig } from '../src/config.js';

export const providerInput = (overrides: Record<string, unknown> = {}) => ({
  command: [process.execPath, '-e', 'process.stdout.write("test-key")'],
  ttlSeconds: 10,
  refreshAheadSeconds: 2,
  timeoutSeconds: 2,
  allowedOrigins: ['https://api.example.test'],
  ...overrides,
});
export function config(overrides: Record<string, unknown> = {}): ProviderConfig {
  return parseConfig({ providers: { test: providerInput(overrides) } }, process.cwd()).get('test')!;
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function safeError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('dynamic-api-key:') && !('cause' in error);
}
