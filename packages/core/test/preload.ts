import path from "path"

process.env.SENTE_DB = ":memory:"
process.env.SENTE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.SENTE_DISABLE_MODELS_FETCH = "true"
