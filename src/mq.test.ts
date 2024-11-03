import { assertEquals, assertGreater } from "@std/assert";
import { delay } from "@std/async/delay";
import postgres from "postgres";
import { PostgresMessageQueue } from "./mq.ts";

// deno-lint-ignore ban-types
function getPostgres(): postgres.Sql<{}> {
  const dbUrl = Deno.env.get("DATABASE_URL");
  return dbUrl == null ? postgres() : postgres(dbUrl);
}

Deno.test("PostgresMessageQueue", async (t) => {
  const sql = getPostgres();
  const sql2 = getPostgres();
  const tableName = `fedify_message_test_${
    Math.random().toString(36).slice(5)
  }`;
  const channelName = `fedify_channel_test_${
    Math.random().toString(36).slice(5)
  }`;
  const mq = new PostgresMessageQueue(sql, { tableName, channelName });
  const mq2 = new PostgresMessageQueue(sql2, { tableName, channelName });

  const messages: string[] = [];
  const controller = new AbortController();
  const listening = mq.listen((message: string) => {
    messages.push(message);
  }, { signal: controller.signal });
  const listening2 = mq2.listen((message: string) => {
    messages.push(message);
  }, { signal: controller.signal });

  await t.step("enqueue()", async () => {
    await mq.enqueue("Hello, world!");
  });

  await waitFor(() => messages.length > 0, 15_000);

  await t.step("listen()", () => {
    assertEquals(messages, ["Hello, world!"]);
  });

  let started = 0;
  await t.step("enqueue() with delay", async () => {
    started = Date.now();
    await mq.enqueue(
      { msg: "Delayed message" },
      { delay: Temporal.Duration.from({ seconds: 3 }) },
    );
  });

  await waitFor(() => messages.length > 1, 15_000);

  await t.step("listen() with delay", () => {
    assertEquals(messages, ["Hello, world!", { msg: "Delayed message" }]);
    assertGreater(Date.now() - started, 3_000);
  });

  controller.abort();
  await listening;
  await listening2;

  await mq.drop();
  await sql.end();
  await sql2.end();
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    await delay(500);
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timeout");
    }
  }
}
