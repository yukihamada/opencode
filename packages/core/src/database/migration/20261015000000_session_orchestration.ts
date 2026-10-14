import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261015000000_session_orchestration",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_orchestration\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`objective\` text NOT NULL,
          \`status\` text NOT NULL,
          \`evaluator\` text,
          \`max_evaluations\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_session_orchestration_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_orchestration_session_idx\` ON \`session_orchestration\` (\`session_id\`);`,
      )
      yield* tx.run(`
        CREATE TABLE \`session_orchestration_evaluation\` (
          \`id\` text PRIMARY KEY,
          \`orchestration_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`verdict\` text NOT NULL,
          \`reason\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_orchestration_evaluation_orchestration_id_session_orchestration_id_fk\` FOREIGN KEY (\`orchestration_id\`) REFERENCES \`session_orchestration\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_orchestration_evaluation_run_seq_idx\` ON \`session_orchestration_evaluation\` (\`orchestration_id\`,\`seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
