import type {
  MessageQueue,
  MessageQueueEnqueueOptions,
  MessageQueueListenOptions,
} from "@fedify/fedify";
import type { Sql } from "postgres";
import postgres from "postgres";

/**
 * Options for the PostgreSQL message queue.
 */
export interface PostgresMessageQueueOptions {
  /**
   * The table name to use for the message queue.
   * `"fedify_message_v2"` by default.
   * @default `"fedify_message_v2"`
   */
  tableName?: string;

  /**
   * The channel name to use for the message queue.
   * `"fedify_channel"` by default.
   * @default `"fedify_channel"`
   */
  channelName?: string;

  /**
   * Whether the table has been initialized.  `false` by default.
   * @default `false`
   */
  initialized?: boolean;

  /**
   * The poll interval for the message queue.  5 seconds by default.
   * @default `{ seconds: 5 }`
   */
  pollInterval?: Temporal.Duration | Temporal.DurationLike;
}

/**
 * A message queue that uses PostgreSQL as the underlying storage.
 *
 * @example
 * ```ts
 * import { createFederation } from "@fedify/fedify";
 * import { PostgresMessageQueue } from "@fedify/postgres";
 * import postgres from "postgres";
 *
 * const federation = createFederation({
 *   // ...
 *   queue: new PostgresMessageQueue(
 *     postgres("postgres://user:pass@localhost/db")
 *   ),
 * });
 * ```
 */
export class PostgresMessageQueue implements MessageQueue {
  // deno-lint-ignore ban-types
  readonly #sql: Sql<{}>;
  readonly #tableName: string;
  readonly #channelName: string;
  readonly #pollIntervalMs: number;
  #initialized: boolean;

  constructor(
    // deno-lint-ignore ban-types
    sql: Sql<{}>,
    options: PostgresMessageQueueOptions = {},
  ) {
    this.#sql = sql;
    this.#tableName = options?.tableName ?? "fedify_message_v2";
    this.#channelName = options?.channelName ?? "fedify_channel";
    this.#pollIntervalMs = Temporal.Duration.from(
      options?.pollInterval ?? { seconds: 5 },
    ).total("millisecond");
    this.#initialized = options?.initialized ?? false;
  }

  async enqueue(
    // deno-lint-ignore no-explicit-any
    message: any,
    options?: MessageQueueEnqueueOptions,
  ): Promise<void> {
    await this.initialize();
    const delay = options?.delay ?? Temporal.Duration.from({ seconds: 0 });
    await this.#sql`
      INSERT INTO ${this.#sql(this.#tableName)} (message, delay)
      VALUES (
        ${this.#sql.json(message)},
        ${delay.toString()}
      );
    `;
    await this.#sql.notify(this.#channelName, delay.toString());
  }

  async listen(
    // deno-lint-ignore no-explicit-any
    handler: (message: any) => void | Promise<void>,
    options: MessageQueueListenOptions = {},
  ): Promise<void> {
    await this.initialize();
    const { signal } = options;
    const poll = async () => {
      while (!signal?.aborted) {
        const query = this.#sql`
          DELETE FROM ${this.#sql(this.#tableName)}
          WHERE id = (
            SELECT id
            FROM ${this.#sql(this.#tableName)}
            WHERE created + delay < CURRENT_TIMESTAMP
            ORDER BY created
            LIMIT 1
          )
          RETURNING message;
        `.execute();
        const cancel = query.cancel.bind(query);
        signal?.addEventListener("abort", cancel);
        let i = 0;
        for (const message of await query) {
          if (signal?.aborted) return;
          await handler(message.message);
          i++;
        }
        signal?.removeEventListener("abort", cancel);
        if (i < 1) break;
      }
    };
    const timeouts = new Set<ReturnType<typeof setTimeout>>();
    const listen = await this.#sql.listen(
      this.#channelName,
      async (delay) => {
        const duration = Temporal.Duration.from(delay);
        const durationMs = duration.total("millisecond");
        if (durationMs < 1) await poll();
        else timeouts.add(setTimeout(poll, durationMs));
      },
      poll,
    );
    signal?.addEventListener("abort", () => {
      listen.unlisten();
      for (const timeout of timeouts) clearTimeout(timeout);
    });
    while (!signal?.aborted) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await new Promise<unknown>((resolve) => {
        signal?.addEventListener("abort", resolve);
        timeout = setTimeout(() => {
          signal?.removeEventListener("abort", resolve);
          resolve(0);
        }, this.#pollIntervalMs);
        timeouts.add(timeout);
      });
      if (timeout != null) timeouts.delete(timeout);
      await poll();
    }
    await new Promise<void>((resolve) => {
      signal?.addEventListener("abort", () => resolve());
      if (signal?.aborted) return resolve();
    });
  }

  /**
   * Initializes the message queue table if it does not already exist.
   */
  async initialize(): Promise<void> {
    if (this.#initialized) return;
    try {
      await this.#sql`
      CREATE TABLE IF NOT EXISTS ${this.#sql(this.#tableName)} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        message jsonb NOT NULL,
        delay interval DEFAULT '0 seconds',
        created timestamp with time zone DEFAULT CURRENT_TIMESTAMP
      );
    `;
    } catch (e) {
      if (
        !(e instanceof postgres.PostgresError &&
          e.constraint_name === "pg_type_typname_nsp_index")
      ) {
        throw e;
      }
    }
    this.#initialized = true;
  }

  /**
   * Drops the message queue table if it exists.
   */
  async drop(): Promise<void> {
    await this.#sql`DROP TABLE IF EXISTS ${this.#sql(this.#tableName)};`;
  }
}

// cSpell: ignore typname
