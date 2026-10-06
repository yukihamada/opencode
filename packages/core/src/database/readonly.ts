export * as DatabaseReadonly from "./readonly"

export type Query = <Row = Record<string, unknown>>(sql: string) => Row[]

/**
 * Run read-only queries against a database file through a separate connection and release
 * the handle before returning. Statements are finalized explicitly: an unfinalized one keeps
 * the file handle open after close(), which on Windows locks the user's database file.
 */
export async function open<Result>(file: string, use: (query: Query) => Result): Promise<Result> {
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite")
    const db = new Database(file, { readonly: true })
    try {
      db.run("PRAGMA busy_timeout = 200")
      return use((sql) => {
        const statement = db.prepare(sql)
        try {
          return statement.all() as never
        } finally {
          statement.finalize()
        }
      })
    } finally {
      db.close()
    }
  }
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec("PRAGMA busy_timeout = 200")
    return use((sql) => db.prepare(sql).all() as never)
  } finally {
    db.close()
  }
}
