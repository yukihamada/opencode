import { Effect, Layer } from "effect"
import { Database } from "@sente-ai/core/database/database"

// Opens the database at argv[2] the way a starting process does (pragmas + migrations), then exits.
await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(process.argv[2]!))))
