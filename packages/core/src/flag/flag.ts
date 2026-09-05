import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["SENTE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["SENTE_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("SENTE_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  SENTE_AUTO_HEAP_SNAPSHOT: truthy("SENTE_AUTO_HEAP_SNAPSHOT"),
  SENTE_GIT_BASH_PATH: process.env["SENTE_GIT_BASH_PATH"],
  SENTE_CONFIG: process.env["SENTE_CONFIG"],
  SENTE_CONFIG_CONTENT: process.env["SENTE_CONFIG_CONTENT"],
  SENTE_DISABLE_AUTOUPDATE: truthy("SENTE_DISABLE_AUTOUPDATE"),
  SENTE_ALWAYS_NOTIFY_UPDATE: truthy("SENTE_ALWAYS_NOTIFY_UPDATE"),
  SENTE_DISABLE_PRUNE: truthy("SENTE_DISABLE_PRUNE"),
  SENTE_DISABLE_TERMINAL_TITLE: truthy("SENTE_DISABLE_TERMINAL_TITLE"),
  SENTE_SHOW_TTFD: truthy("SENTE_SHOW_TTFD"),
  SENTE_DISABLE_AUTOCOMPACT: truthy("SENTE_DISABLE_AUTOCOMPACT"),
  SENTE_DISABLE_DEGRADE_RESCUE: truthy("SENTE_DISABLE_DEGRADE_RESCUE"),
  SENTE_DISABLE_MODELS_FETCH: truthy("SENTE_DISABLE_MODELS_FETCH"),
  SENTE_DISABLE_MOUSE: truthy("SENTE_DISABLE_MOUSE"),
  SENTE_FAKE_VCS: process.env["SENTE_FAKE_VCS"],
  SENTE_SERVER_PASSWORD: process.env["SENTE_SERVER_PASSWORD"],
  SENTE_SERVER_USERNAME: process.env["SENTE_SERVER_USERNAME"],
  SENTE_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("SENTE_DISABLE_FFF"),

  // Experimental
  SENTE_EXPERIMENTAL_FILEWATCHER: Config.boolean("SENTE_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  SENTE_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("SENTE_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  SENTE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("SENTE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  SENTE_MODELS_URL: process.env["SENTE_MODELS_URL"],
  SENTE_MODELS_PATH: process.env["SENTE_MODELS_PATH"],
  SENTE_DB: process.env["SENTE_DB"],

  SENTE_WORKSPACE_ID: process.env["SENTE_WORKSPACE_ID"],
  SENTE_EXPERIMENTAL_WORKSPACES: enabledByExperimental("SENTE_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get SENTE_DISABLE_PROJECT_CONFIG() {
    return truthy("SENTE_DISABLE_PROJECT_CONFIG")
  },
  get SENTE_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("SENTE_EXPERIMENTAL_REFERENCES")
  },
  get SENTE_TUI_CONFIG() {
    return process.env["SENTE_TUI_CONFIG"]
  },
  get SENTE_CONFIG_DIR() {
    return process.env["SENTE_CONFIG_DIR"]
  },
  get SENTE_PURE() {
    return truthy("SENTE_PURE")
  },
  get SENTE_PERMISSION() {
    return process.env["SENTE_PERMISSION"]
  },
  get SENTE_PLUGIN_META_FILE() {
    return process.env["SENTE_PLUGIN_META_FILE"]
  },
  get SENTE_CLIENT() {
    return process.env["SENTE_CLIENT"] ?? "cli"
  },
}
