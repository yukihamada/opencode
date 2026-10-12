import { Pty } from "@sente-ai/core/pty"
import { PtyProtocol } from "@sente-ai/core/pty/protocol"
import { PtyTicket } from "@sente-ai/core/pty/ticket"
import { Location } from "@sente-ai/core/location"
import { Effect, Queue } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { Api } from "../api"
import { CorsConfig, isAllowedRequestOrigin } from "../cors"
import { ForbiddenError, PtyNotFoundError } from "@sente-ai/protocol/errors"
import {
  PTY_CONNECT_TICKET_QUERY,
  PTY_CONNECT_TOKEN_HEADER,
  PTY_CONNECT_TOKEN_HEADER_VALUE,
} from "@sente-ai/protocol/groups/pty"
import { response } from "../location"
import { PtyEnvironment } from "../pty-environment"

const ticketScope = Effect.gen(function* () {
  const location = yield* Location.Service
  return { directory: location.directory as string, workspaceID: location.workspaceID }
})

// Outbound frames waiting on a slow websocket client must stay byte-bounded: an unbounded
// outbox lets a stalled client grow server memory without limit.
export const MAX_PENDING_OUTPUT_BYTES = 1024 * 1024

// Byte gate around the outbound queue. Once the pending byte count crosses the limit the
// gate overflows: no chunk is dropped silently, instead the connection is terminated with a
// close frame and the PTY attachment is detached.
export const makeOutputGate = Effect.fnUntraced(function* (input: {
  limit?: number
  onEnd: () => void
  onOverflow: () => void
}) {
  const limit = input.limit ?? MAX_PENDING_OUTPUT_BYTES
  const queue = yield* Queue.unbounded<string | Uint8Array | Socket.CloseEvent>()
  const state = { pending: 0, overflowed: false }
  const size = (item: string | Uint8Array) =>
    typeof item === "string" ? new TextEncoder().encode(item).byteLength : item.byteLength
  const offer = (item: string | Uint8Array) => {
    if (state.overflowed) return
    state.pending += size(item)
    if (state.pending > limit) {
      state.overflowed = true
      Queue.offerUnsafe(queue, new Socket.CloseEvent(1013, "output overflow"))
      input.onOverflow()
      return
    }
    Queue.offerUnsafe(queue, item)
  }
  const end = () => {
    if (state.overflowed) return
    Queue.offerUnsafe(queue, new Socket.CloseEvent(1000))
    input.onEnd()
  }
  return {
    offer,
    end,
    take: Effect.gen(function* () {
      const item = yield* Queue.take(queue)
      if (!(item instanceof Socket.CloseEvent)) state.pending = Math.max(0, state.pending - size(item))
      return item
    }),
  }
})

export const PtyHandler = HttpApiBuilder.group(Api, "server.pty", (handlers) =>
  Effect.gen(function* () {
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig
    const environment = yield* PtyEnvironment.Service

    return handlers
      .handle(
        "pty.list",
        Effect.fn(function* () {
          return yield* response((yield* Pty.Service).list())
        }),
      )
      .handle(
        "pty.create",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          const location = yield* Location.Service
          const cwd = ctx.payload.cwd || location.directory
          return yield* response(
            pty.create({
              ...ctx.payload,
              args: ctx.payload.args ? [...ctx.payload.args] : undefined,
              cwd,
              env: {
                ...ctx.payload.env,
                ...(yield* environment.get({ directory: location.directory, cwd })),
              },
            }),
          )
        }),
      )
      .handle(
        "pty.get",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          return yield* response(
            pty.get(ctx.params.ptyID).pipe(
              Effect.catchTag(
                "Pty.NotFoundError",
                () =>
                  new PtyNotFoundError({
                    ptyID: ctx.params.ptyID,
                    message: `PTY session not found: ${ctx.params.ptyID}`,
                  }),
              ),
            ),
          )
        }),
      )
      .handle(
        "pty.update",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          return yield* response(
            pty
              .update(ctx.params.ptyID, {
                ...ctx.payload,
                size: ctx.payload.size ? { ...ctx.payload.size } : undefined,
              })
              .pipe(
                Effect.catchTag(
                  "Pty.NotFoundError",
                  () =>
                    new PtyNotFoundError({
                      ptyID: ctx.params.ptyID,
                      message: `PTY session not found: ${ctx.params.ptyID}`,
                    }),
                ),
              ),
          )
        }),
      )
      .handle(
        "pty.remove",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          yield* pty.remove(ctx.params.ptyID).pipe(
            Effect.catchTag(
              "Pty.NotFoundError",
              () =>
                new PtyNotFoundError({
                  ptyID: ctx.params.ptyID,
                  message: `PTY session not found: ${ctx.params.ptyID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "pty.connectToken",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          // The custom header forces a CORS preflight, so cross-origin browser pages cannot
          // mint tickets without passing the server's origin policy.
          if (
            request.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE ||
            !isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors)
          )
            return yield* new ForbiddenError({ message: "Invalid PTY connect token request" })
          const pty = yield* Pty.Service
          yield* pty.get(ctx.params.ptyID).pipe(
            Effect.catchTag(
              "Pty.NotFoundError",
              () =>
                new PtyNotFoundError({
                  ptyID: ctx.params.ptyID,
                  message: `PTY session not found: ${ctx.params.ptyID}`,
                }),
            ),
          )
          return yield* response(tickets.issue({ ptyID: ctx.params.ptyID, ...(yield* ticketScope) }))
        }),
      )
      .handleRaw(
        "pty.connect",
        Effect.fn("PtyHandler.connect")(function* (ctx) {
          const pty = yield* Pty.Service
          const exists = yield* pty.get(ctx.params.ptyID).pipe(
            Effect.as(true),
            Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
          )
          if (!exists) return HttpServerResponse.empty({ status: 404 })

          const url = new URL(ctx.request.url, "http://localhost")
          const ticket = url.searchParams.get(PTY_CONNECT_TICKET_QUERY)
          if (ticket) {
            const valid = isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors)
              ? yield* tickets.consume({ ticket, ptyID: ctx.params.ptyID, ...(yield* ticketScope) })
              : false
            if (!valid) return HttpServerResponse.empty({ status: 403 })
          }
          const parsedCursor = url.searchParams.get("cursor")
          const cursorNumber = parsedCursor === null ? undefined : Number(parsedCursor)
          const cursor =
            cursorNumber !== undefined && Number.isSafeInteger(cursorNumber) && cursorNumber >= -1
              ? cursorNumber
              : undefined

          const socket = yield* Effect.orDie(ctx.request.upgrade)
          const write = yield* socket.writer
          const closeAccepted = (event: Socket.CloseEvent) =>
            socket
              .runRaw(() => Effect.void, { onOpen: write(event).pipe(Effect.catch(() => Effect.void)) })
              .pipe(
                Effect.timeout("1 second"),
                Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
                Effect.catch(() => Effect.void),
              )

          // Outbound frames flow through one byte-bounded gate drained by a single writer so
          // replay, live output, and the close frame keep their order. Overflow terminates
          // this websocket and detaches; the PTY session itself keeps running.
          // TODO: Integrate graceful-shutdown socket tracking before clients migrate to this route.
          const attachmentRef: { detach?: () => void } = {}
          const outbox = yield* makeOutputGate({
            onEnd: () => {},
            onOverflow: () => attachmentRef.detach?.(),
          })
          const attachment = yield* pty
            .attach(ctx.params.ptyID, {
              cursor,
              onData: (chunk) => outbox.offer(chunk),
              onEnd: () => outbox.end(),
            })
            .pipe(
              Effect.catchTags({
                "Pty.NotFoundError": () =>
                  closeAccepted(new Socket.CloseEvent(4404, "session not found")).pipe(Effect.as(undefined)),
                "Pty.ExitedError": () =>
                  closeAccepted(new Socket.CloseEvent(4404, "session exited")).pipe(Effect.as(undefined)),
              }),
            )
          if (!attachment) return HttpServerResponse.empty()

          attachmentRef.detach = attachment.detach
          for (const chunk of PtyProtocol.chunks(attachment.replay)) outbox.offer(chunk)
          outbox.offer(PtyProtocol.metaFrame(attachment.cursor))
          attachment.activate()

          const drain = Effect.gen(function* () {
            while (true) {
              const item = yield* outbox.take
              yield* write(item)
              if (item instanceof Socket.CloseEvent) return
            }
          })

          yield* Effect.race(
            drain,
            socket.runRaw((message) => {
              const decoded = PtyProtocol.decodeInput(message)
              if (decoded !== undefined) attachment.write(decoded)
            }),
          ).pipe(
            Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
            Effect.ensuring(Effect.sync(() => attachment.detach())),
            Effect.orDie,
          )
          return HttpServerResponse.empty()
        }),
      )
  }),
)
