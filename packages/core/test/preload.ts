import os from "os"
import path from "path"
import { mkdtempSync } from "fs"

// Before any src/ import resolves Global.Path: tests such as models.test.ts write and delete
// <cache>/models.json, which without this is the user's real ~/.cache/sente/models.json
// (a running Sente could read the fixture catalog, and the real cache is deleted).
process.env.XDG_CACHE_HOME = mkdtempSync(path.join(os.tmpdir(), "sente-core-test-cache-"))

process.env.SENTE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
process.env.SENTE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.SENTE_DISABLE_MODELS_FETCH = "true"
