import type { KvKey, KvStore, KvStoreSetOptions } from "@fedify/fedify";
import type { Sql } from "postgres";

/**
 * Options for the PostgreSQL key-value store.
 */
export interface PostgresKvStoreOptions {
  /**
   * The table name to use for the key-value store.  `"fedify_kv"` by default.
   * @default `"fedify_kv"`
   */
  tableName?: string;

  /**
   * Whether the table has been initialized.  `false` by default.
   * @default `false`
   */
  initialized?: boolean;
}

/**
 * A key-value store that uses PostgreSQL as the underlying storage.
 *
 * @example
 * ```ts
 * import { createFederation } from "@fedify/fedify";
 * import { PostgresKvStore } from "@fedify/postgres";
 * import postgres from "postgres";
 *
 * const federation = createFederation({
 *   // ...
 *   kv: new PostgresKvStore(postgres("postgres://user:pass@localhost/db")),
 * });
 * ```
 */
export class PostgresKvStore implements KvStore {
  // deno-lint-ignore ban-types
  readonly #sql: Sql<{}>;
  readonly #tableName: string;
  #initialized: boolean;

  /**
   * Creates a new PostgreSQL key-value store.
   * @param sql The PostgreSQL client to use.
   * @param options The options for the key-value store.
   */
  constructor(
    // deno-lint-ignore ban-types
    sql: Sql<{}>,
    options: PostgresKvStoreOptions = {},
  ) {
    this.#sql = sql;
    this.#tableName = options.tableName ?? "fedify_kv";
    this.#initialized = options.initialized ?? false;
  }

  async #expire(): Promise<void> {
    await this.#sql`
      DELETE FROM ${this.#sql(this.#tableName)}
      WHERE ttl IS NOT NULL AND created + ttl < CURRENT_TIMESTAMP;
    `;
  }

  async get<T = unknown>(key: KvKey): Promise<T | undefined> {
    await this.initialize();
    const result = await this.#sql`
      SELECT value
      FROM ${this.#sql(this.#tableName)}
      WHERE key = ${key} AND (ttl IS NULL OR created + ttl > CURRENT_TIMESTAMP);
    `;
    if (result.length < 1) return undefined;
    return JSON.parse(result[0].value) as T;
  }

  async set(
    key: KvKey,
    value: unknown,
    options?: KvStoreSetOptions | undefined,
  ): Promise<void> {
    await this.initialize();
    const ttl = options?.ttl == null ? null : options.ttl.toString();
    await this.#sql`
      INSERT INTO ${this.#sql(this.#tableName)} (key, value, ttl)
      VALUES (${key}, ${JSON.stringify(value)}, ${ttl})
      ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, ttl = EXCLUDED.ttl;
    `;
    await this.#expire();
  }

  async delete(key: KvKey): Promise<void> {
    await this.initialize();
    await this.#sql`
      DELETE FROM ${this.#sql(this.#tableName)}
      WHERE key = ${key};
    `;
    await this.#expire();
  }

  /**
   * Creates the table used by the key-value store if it does not already exist.
   * Does nothing if the table already exists.
   */
  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#sql`
      CREATE UNLOGGED TABLE IF NOT EXISTS ${this.#sql(this.#tableName)} (
        key text[] PRIMARY KEY,
        value jsonb NOT NULL,
        created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
        ttl interval
      );
    `;
    this.#initialized = true;
  }

  /**
   * Drops the table used by the key-value store.  Does nothing if the table
   * does not exist.
   */
  async drop(): Promise<void> {
    await this.#sql`DROP TABLE IF EXISTS ${this.#sql(this.#tableName)};`;
  }
}