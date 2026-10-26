import { defaultPolicy } from '../policy/index.js';
import { MemoryStore } from './memory.js';
import { PostgresStore } from './postgres.js';
import type { Store } from './types.js';

export type { Store } from './types.js';
export { MemoryStore } from './memory.js';
export { PostgresStore } from './postgres.js';

/**
 * Picks the store backend from the environment.
 *
 * Set RVN_DATABASE_URL (or DATABASE_URL) to a Postgres connection string to
 * persist everything; anything else — unset, unreachable, auth failure,
 * schema error — falls back to the in-memory store with a loud log line, so
 * the API always boots. Default policy ('*') is seeded when absent.
 */
export async function storeFromEnv(log: (msg: string) => void = () => undefined): Promise<Store> {
  const databaseUrl = process.env.RVN_DATABASE_URL ?? process.env.DATABASE_URL;
  let store: Store;
  if (databaseUrl) {
    try {
      store = await PostgresStore.connect(databaseUrl);
      log(`store: postgres (${redactUrl(databaseUrl)})`);
    } catch (err) {
      log(
        `store: postgres unreachable (${(err as Error).message}) — falling back to in-memory; nothing is persisted`,
      );
      store = new MemoryStore();
    }
  } else {
    log('store: in-memory (set RVN_DATABASE_URL to persist to Postgres)');
    store = new MemoryStore();
  }
  if (!(await store.policies.get('*'))) {
    await store.policies.set(defaultPolicy());
  }
  return store;
}

/** Strip credentials before a connection string ever hits a log line. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch {
    return '<unparseable url>';
  }
}
