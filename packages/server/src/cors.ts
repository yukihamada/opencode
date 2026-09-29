import { Context } from "effect"

const senteHost = /^([a-z0-9-]+\.)*teai\.io$/

export type CorsOptions = { readonly cors?: ReadonlyArray<string> }

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@sente/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (input === "oc://renderer") return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  const origin = parseOrigin(input)
  if (origin?.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)) return true
  if (origin?.protocol === "https:" && !origin.port && senteHost.test(origin.hostname)) return true
  return opts?.cors?.includes(input) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input, opts)
}

function sameHost(origin: string, host: string) {
  return parseOrigin(origin)?.host === host
}

function parseOrigin(input: string) {
  const url = URL.parse(input)
  // Origin headers contain only a serialized HTTP(S) origin, never credentials or paths.
  if (!url || !["http:", "https:"].includes(url.protocol) || url.origin !== input) return undefined
  return url
}
