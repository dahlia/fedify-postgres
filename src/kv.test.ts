import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/assert-equals";
import { assertFalse } from "@std/assert/assert-false";
import { delay } from "@std/async/delay";
import postgres from "postgres";
import { PostgresKvStore } from "./kv.ts";

Deno.test("PostgresKvStore", async (t) => {
  const dbUrl = Deno.env.get("DATABASE_URL");
  const sql = dbUrl == null ? postgres() : postgres(dbUrl);
  const tableName = `fedify_kv_test_${Math.random().toString(36).slice(5)}`;
  const store = new PostgresKvStore(sql, { tableName });

  await t.step("initialize()", async () => {
    await store.initialize();
    const result = await sql`
      SELECT to_regclass(${tableName}) IS NOT NULL AS exists;
    `;
    assert(result[0].exists);
  });

  await t.step("get()", async () => {
    await sql`
      INSERT INTO ${sql(tableName)} (key, value)
      VALUES (${["foo", "bar"]}, ${["foobar"]})
    `;
    assertEquals(await store.get(["foo", "bar"]), ["foobar"]);

    await sql`
      INSERT INTO ${sql(tableName)} (key, value, ttl)
      VALUES (${["foo", "bar", "ttl"]}, ${["foobar"]}, ${"0 seconds"})
    `;
    await delay(500);
    assertEquals(await store.get(["foo", "bar", "ttl"]), undefined);
  });

  await t.step("set()", async () => {
    await store.set(["foo", "baz"], "baz");
    const result = await sql`
      SELECT * FROM ${sql(tableName)}
      WHERE key = ${["foo", "baz"]}
    `;
    assertEquals(result.length, 1);
    assertEquals(result[0].key, ["foo", "baz"]);
    assertEquals(result[0].value, "baz");
    assertEquals(result[0].ttl, null);

    await store.set(["foo", "qux"], "qux", {
      ttl: Temporal.Duration.from({ days: 1 }),
    });
    const result2 = await sql`
        SELECT * FROM ${sql(tableName)}
        WHERE key = ${["foo", "qux"]}
    `;
    assertEquals(result2.length, 1);
    assertEquals(result2[0].key, ["foo", "qux"]);
    assertEquals(result2[0].value, "qux");
    assertEquals(result2[0].ttl, "1 day");
  });

  await t.step("delete()", async () => {
    await store.delete(["foo", "bar"]);
    const result = await sql`
        SELECT * FROM ${sql(tableName)}
        WHERE key = ${["foo", "bar"]}
    `;
    assertEquals(result.length, 0);
  });

  await t.step("drop()", async () => {
    await store.drop();
    const result = await sql`
      SELECT to_regclass(${tableName}) IS NOT NULL AS exists;
    `;
    assertFalse(result[0].exists);
  });

  await sql.end();
});

// cSpell: ignore regclass
