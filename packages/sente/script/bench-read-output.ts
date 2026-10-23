import { Database } from "bun:sqlite"
import { DEFAULT_READ_LIMIT, MAX_BYTES } from "../src/tool/read"

// Counterfactual pagination of saved text only. No source files or DB rows are changed.
// Do not print saved content or paths. Follow-up reads and actual billing are not modeled.
const [file, end] = process.argv.slice(2)
if (!file) throw new Error("Usage: bun script/bench-read-output.ts DB [END_TIME_MS]")
const db = new Database(file, { readonly: true })
try {
  const cutoff = end
    ? Number(end)
    : db.query<{ time: number }, []>("SELECT max(time_created) AS time FROM message").get()!.time
  if (!Number.isFinite(cutoff)) throw new Error("Invalid end time")
  const records = db
    .query<{ output: string; limit: number | null }, [number, number]>(
      `SELECT json_extract(data, '$.state.output') AS output,
              json_extract(data, '$.state.input.limit') AS "limit" FROM part
       WHERE time_created BETWEEN ? AND ? AND json_extract(data, '$.type') = 'tool'
       AND json_extract(data, '$.tool') = 'read' AND json_extract(data, '$.state.status') = 'completed'`,
    )
    .all(cutoff - 3 * 86400000, cutoff)
  let original = 0
  let projected = 0
  let parsed = 0
  let affected = 0
  for (const record of records) {
    original += Buffer.byteLength(record.output)
    const body = /<content>\n([\s\S]*?)\n\n\([^\n]*\)\n<\/content>/.exec(record.output)
    const lines = body?.[1].split("\n")
    if (!body || !lines?.length || lines.some((line) => !/^\d+: /.test(line))) {
      projected += Buffer.byteLength(record.output)
      continue
    }
    parsed++
    let bytes = 0
    let kept = 0
    for (const line of lines) {
      const size = Buffer.byteLength(line) + (kept > 0 ? 1 : 0)
      if (bytes + size > MAX_BYTES || kept >= (record.limit ?? DEFAULT_READ_LIMIT)) break
      bytes += size
      kept++
    }
    if (kept === lines.length || kept === 0) {
      projected += Buffer.byteLength(record.output)
      continue
    }
    affected++
    const start = Number(lines[0].split(":", 1)[0])
    const last = Number(lines[kept - 1].split(":", 1)[0])
    const replacement = `<content>\n${lines.slice(0, kept).join("\n")}\n\n(Output capped at ${MAX_BYTES / 1024} KB or ${record.limit ?? DEFAULT_READ_LIMIT} lines. Showing lines ${start}-${last}. Use offset=${last + 1} to continue.)\n</content>`
    // Keep instructions and all other text outside the body intact.
    projected += Buffer.byteLength(
      record.output.slice(0, body.index) + replacement + record.output.slice(body.index + body[0].length),
    )
  }
  console.log(
    JSON.stringify(
      {
        cutoff,
        days: 3,
        records: records.length,
        parsed,
        affected,
        defaultLines: DEFAULT_READ_LIMIT,
        textByteCap: MAX_BYTES,
        originalBytes: original,
        projectedBytes: projected,
        savedBytes: original - projected,
        reductionPercent: Number(((1 - projected / original) * 100).toFixed(2)),
        scope: "Saved-text pagination estimate; extra reads, tokens, latency, quality and billed savings unverified",
      },
      null,
      2,
    ),
  )
} finally {
  db.close()
}
