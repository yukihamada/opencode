import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815132324_add_session_hidden",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`hidden\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
