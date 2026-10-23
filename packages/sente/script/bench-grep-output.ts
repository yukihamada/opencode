import { Database } from "bun:sqlite"
import { formatMatches } from "../src/tool/grep"

// Replay saved display rows, not searches against files that may have changed.
// Only aggregate sizes are printed; saved output and paths stay local.
const [file, session, before] = process.argv.slice(2)
if (!file || !session || !before) throw new Error("Usage: bun script/bench-grep-output.ts DB SESSION BEFORE_MESSAGE")
const db = new Database(file, { readonly: true })
try {
  const records = db
    .query<{ output: string }, [string, string]>(
      `SELECT json_extract(data, '$.state.output') AS output FROM part
       WHERE session_id = ? AND message_id < ? AND json_extract(data, '$.type') = 'tool'
       AND json_extract(data, '$.tool') = 'grep' AND json_extract(data, '$.state.status') = 'completed'`,
    )
    .all(session, before)
  let original = 0
  let formatted = 0
  let parsed = 0
  let unparsed = 0
  let bounded = 0
  let max = 0
  for (const record of records) {
    original += Array.from(record.output).length
    let current = ""
    const rows: { path: string; line: number; text: string }[] = []
    for (const line of record.output.split("\n")) {
      if (line.startsWith("/") && line.endsWith(":")) current = line.slice(0, -1)
      const match = /^\s+Line (\d+): (.*)$/.exec(line)
      if (!match || !current) continue
      rows.push({
        path: current,
        line: Number(match[1]),
        text: match[2],
      })
    }
    if (rows.length === 0) {
      unparsed++
      formatted += Array.from(record.output).length
      continue
    }
    parsed++
    const capped = rows.length >= 100
    const result = formatMatches(rows, { truncated: capped, hasMore: capped })
    if (result.length > 8_000) throw new Error("Output budget exceeded")
    if (capped) bounded++
    max = Math.max(max, result.length)
    formatted += Array.from(result).length
  }
  console.log(
    JSON.stringify(
      {
        records: records.length,
        parsed,
        unparsed,
        bounded,
        originalChars: original,
        formattedChars: formatted,
        reductionPercent: original ? Number(((1 - formatted / original) * 100).toFixed(2)) : 0,
        maxFormattedCodeUnits: max,
        scope: "Saved display rows only; no claim about latency, tokens, or follow-up reads",
      },
      null,
      2,
    ),
  )
} finally {
  db.close()
}
