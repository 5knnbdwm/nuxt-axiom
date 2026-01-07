import { createSpan, SpanKind, ok, err, type Result } from "./otel";

/**
 * Example database service with traced operations.
 */

export type DbError = {
  code: "CONNECTION_ERROR" | "QUERY_ERROR" | "NOT_FOUND";
  message: string;
};

export async function queryDatabase<T>(
  operation: string,
  query: string,
  fn: () => Promise<Result<T, DbError>>
): Promise<Result<T, DbError>> {
  return createSpan(
    `db.${operation}`,
    async (span) => {
      span.setAttribute("db.system", "postgresql");
      span.setAttribute("db.operation", operation);
      span.setAttribute("db.statement", query);

      return fn();
    },
    { kind: SpanKind.CLIENT }
  );
}

export async function findOne(
  table: string,
  id: number
): Promise<Result<{ id: number; table: string; found: true }, DbError>> {
  return queryDatabase(
    "findOne",
    `SELECT * FROM ${table} WHERE id = ?`,
    async () => {
      // Simulate DB query
      await new Promise((resolve) => setTimeout(resolve, 15));
      return ok({ id, table, found: true as const });
    }
  );
}

export async function insertRecord(
  table: string,
  data: Record<string, unknown>
): Promise<Result<{ id: number } & Record<string, unknown>, DbError>> {
  return queryDatabase(
    "insert",
    `INSERT INTO ${table} VALUES (?)`,
    async () => {
      // Simulate DB insert
      await new Promise((resolve) => setTimeout(resolve, 25));
      return ok({ id: Math.floor(Math.random() * 1000), ...data });
    }
  );
}
