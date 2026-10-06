/**
 * 起動中セッションへ teai.io の API キーを反映する。
 *
 * キーは起動時に env → 設定 → SDK へ焼き込まれるので、別の端末で `te key rotate` や
 * `/login` をしても、動いているセッションは古いキーのまま 401/402 を受け続ける
 * (2026-09-18 の「こちらはデモです」障害)。ここでは認証・上限系の失敗を受けたときだけ
 * 保存済み credentials を読み直し、キーが変わっていれば新しいキーで **1回だけ** 再送する。
 *
 * - 変わっていなければ何もしない(元の応答をそのまま返す。原因別の案内は呼び出し側が出す)。
 * - 再送は1リクエストにつき1回。再送結果が失敗でもそれ以上は試さない。
 * - 起動時に env のキーが保存済みキーと違っていた場合(`TEAI_API_KEY=… te` や
 *   プロジェクト別キーの明示指定)は差し替えない。別のキーで勝手に課金しないため。
 * - 送信先が teai の公式 API ホスト(既定 https://api.teai.io、TEAI_API で上書きされた接続先)と
 *   一致するときだけ。`teai-xxx` という名前で別ホストを指す設定には、保存済みキーを送らない。
 * - 保護モード(SENTE_SCRUB_KEY)では実キーを読まない。
 * - キーの値はログにも例外にも出さない。
 */
import { Effect } from "effect"
import * as Observability from "@sente-ai/core/observability"
import { apiBase, credentialsPath, parseCredentials, TEAI_KEY_ENV } from "@sente-ai/tui/util/teai"

type Env = Record<string, string | undefined>

/** 起動時にキーがどこから来たか。"env" = 保存済みと違うキーを明示指定して起動した。 */
export const SOURCE_ENV = "SENTE_TEAI_KEY_SOURCE"

export type Failure = "invalid" | "limit" | "balance" | "demo"

const INVALID = /invalid[_ ]api[_ ]key|api key.*(invalid|revoked|expired)|key_revoked|unauthorized|unauthenticated/i

/**
 * キーを替えれば直りうる失敗かどうか。401 = 失効、402 = キー上限/残高/キー無しデモ。
 * 403/409 は本文がキー失効を示すときだけ(コンテンツ拒否や競合を巻き込まない)。
 */
export function failure(status: number, body: string): Failure | undefined {
  if (status === 401) return "invalid"
  if (status === 402) {
    if (/anonymous_demo_only|signup_required/.test(body)) return "demo"
    if (/api_key_(minute|hourly|daily|monthly)_limit_exceeded|reached its (per-minute|hourly|daily|monthly) limit/i.test(body))
      return "limit"
    return "balance"
  }
  if ((status === 403 || status === 409) && INVALID.test(body)) return "invalid"
  return undefined
}

/**
 * 起動時(設定展開・Worker 生成の前)に1回だけ呼ぶ。保存済みキーと env のキーを比べ、
 * 明示的な上書きかどうかを Worker にも伝わる env に残す。
 */
export async function markSource(env: Env = process.env, home?: string) {
  if (env[SOURCE_ENV]) return
  const saved = await savedKey(env, home)
  const current = env[TEAI_KEY_ENV]
  env[SOURCE_ENV] = current && current !== saved ? "env" : "saved"
}

/** 保存済み credentials のキー。無ければ undefined。保護モードでは読まない。 */
export async function savedKey(env: Env = process.env, home?: string) {
  if (env.SENTE_SCRUB_KEY) return undefined
  const text = await Bun.file(credentialsPath(env, home))
    .text()
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
  return parseCredentials(text)
}

/**
 * 送信先が teai の公式 API か(スキーム・ホスト・ポートの一致)。保存済みキーは teai のものなので、
 * プロバイダ名が teai で始まっていても、別ホストへは載せない。
 */
export function official(input: string | URL, env: Env = process.env) {
  try {
    return new URL(String(input)).origin === new URL(apiBase(env)).origin
  } catch {
    // URL として読めない送信先は公式ではない。
    return false
  }
}

/** 既定のログ出力(ファイルログ。キーや応答本文は渡さない)。 */
function warn(message: string, fields: Record<string, string | number>) {
  Effect.runFork(Effect.logWarning(message, fields).pipe(Effect.provide(Observability.layer)))
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : typeof error
}

function bearer(headers: Headers) {
  const match = /^Bearer\s+(.*)$/i.exec(headers.get("authorization") ?? "")
  return match?.[1]?.trim() ?? ""
}

/** 再送できる本文だけを対象にする(一度読むと消えるストリームは再送しない)。 */
function replayable(body: unknown) {
  return body === undefined || body === null || typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer
}

type FetchLike = (input: any, init?: any) => Promise<Response>

export type Options = {
  env?: Env
  home?: string
  /** 保存済みキーの読み出し(テスト用の差し替え口)。 */
  read?: () => Promise<string | undefined>
  /** 読み捨てた失敗を1行残す先(既定はファイルログ)。キーや応答本文は渡さない。 */
  log?: (message: string, fields: Record<string, string | number>) => void
  /** 差し替えが起きたときの通知。キーの値は渡さない。 */
  onSwap?: (info: { reason: Failure; status: number }) => void
}

/**
 * teai 向け fetch を包む。プロセス内で「古いキー → 新しいキー」を覚え、以後のリクエストは
 * 最初から新しいキーで送る(毎回 失敗→再送 の2往復にしない)。
 */
export function wrap(fetchFn: FetchLike, opts: Options = {}): FetchLike {
  const env = opts.env ?? process.env
  const read = opts.read ?? (() => savedKey(env, opts.home))
  const log = opts.log ?? warn
  const swapped = new Map<string, string>()

  return async (input, init) => {
    // Request オブジェクトで渡された場合は中身を作り直せないので素通し。
    if (typeof input !== "string" && !(input instanceof URL)) return fetchFn(input, init)
    // 公式の teai API 以外(名前だけ teai-… の別ホスト)には保存済みキーを一切載せない。
    if (!official(input, env)) return fetchFn(input, init)

    const send = (key: string | undefined) => {
      if (key === undefined) return fetchFn(input, init)
      const headers = new Headers(init?.headers)
      headers.set("authorization", `Bearer ${key}`)
      return fetchFn(input, { ...init, headers })
    }

    const original = bearer(new Headers(init?.headers))
    const known = swapped.get(original)
    const used = known ?? original
    const response = await send(known)

    if (response.ok || response.status < 400) return response
    if (env[SOURCE_ENV] === "env" || env.SENTE_SCRUB_KEY) return response
    if (!replayable(init?.body)) return response
    // 401 は本文なしで判定できる。それ以外は複製して本文から原因を読む(元の応答は消費しない)。
    const text =
      response.status === 401
        ? ""
        : // clone() は本文が使用済みだと同期的に投げるので、Promise の中で呼ぶ。
          await Promise.resolve()
            .then(() => response.clone().text())
            .catch((error: unknown) => {
              // 本文が読めなければ原因を本文から判定できない。状態コードだけで続ける。
              log("teai key reload: could not read failure body", { status: response.status, error: errorName(error) })
              return ""
            })
    const reason = failure(response.status, text)
    if (!reason) return response

    const fresh = await read()
    if (!fresh || fresh === used) return response

    // ここから先は1回だけ。結果が何であれ再々送はしない。
    await response.body?.cancel().catch((error: unknown) => {
      // 捨てる側の応答を閉じられなかっただけ。再送は続ける。
      log("teai key reload: could not release failed response", { status: response.status, error: errorName(error) })
    })
    swapped.set(original, fresh)
    env[TEAI_KEY_ENV] = fresh
    opts.onSwap?.({ reason, status: response.status })
    return send(fresh)
  }
}

export * as ProviderKeyReload from "./key-reload"
