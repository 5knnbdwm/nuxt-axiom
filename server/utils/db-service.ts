import { createSpan, SpanKind } from "./otel";

/**
 * Example database service with traced operations.
 */

export async function queryDatabase<T>(
  operation: string,
  query: string,
  fn: () => Promise<T>
): Promise<T> {
  return createSpan(
    `db.${operation}`,
    async (span) => {
      span.setAttribute("db.system", "postgresql");
      span.setAttribute("db.operation", operation);
      span.setAttribute("db.statement", query);

      const result = await fn();

      return result;
    },
    { kind: SpanKind.CLIENT }
  );
}

export async function findOne(table: string, id: number) {
  return queryDatabase(
    "findOne",
    `SELECT * FROM ${table} WHERE id = ?`,
    async () => {
      // Simulate DB query
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { id, table, found: true };
    }
  );
}

export async function insertRecord(
  table: string,
  data: Record<string, unknown>
) {
  return queryDatabase(
    "insert",
    `INSERT INTO ${table} VALUES (?)`,
    async () => {
      // Simulate DB insert
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { id: Math.floor(Math.random() * 1000), ...data };
    }
  );
}
