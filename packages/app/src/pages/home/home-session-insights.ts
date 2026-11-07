import type { Session, SnapshotFileDiff, Todo } from "@sente-ai/sdk/v2/client"
import { createMemo, createResource, type Accessor } from "solid-js"
import { untrack } from "solid-js"
import type { HomeController } from "./home-controller"
import type { HomeSessionRecord } from "./home-sessions-controller"

const INSIGHT_SESSION_LIMIT = 8
const INSIGHT_TODO_LIMIT = 12
const INSIGHT_CHANGE_LIMIT = 12
const OPEN_TODO_STATUS = new Set(["pending", "in_progress"])

export type HomeTodoItem = {
  sessionID: string
  session: Session
  sessionTitle: string
  projectName: string
  content: string
  status: string
  priority: string
}

export type HomeChangeItem = {
  sessionID: string
  session: Session
  sessionTitle: string
  projectName: string
  file: string
  additions: number
  deletions: number
  status?: SnapshotFileDiff["status"]
}

type SessionInsight = {
  record: HomeSessionRecord
  todos: Todo[]
  diffs: SnapshotFileDiff[]
}

export function createHomeSessionInsights(home: HomeController, records: Accessor<HomeSessionRecord[]>) {
  const visible = createMemo(() => records().slice(0, INSIGHT_SESSION_LIMIT))
  const key = createMemo(() => visible().map((record) => record.session.id).join(","))

  const [resource] = createResource(key, async () => {
    const ctx = home.server.focusedContext()
    if (!ctx) return [] as SessionInsight[]
    const list = untrack(visible)
    const results = await Promise.allSettled(
      list.map(async (record): Promise<SessionInsight> => {
        const directory = record.session.directory
        const [todos, diffs] = await Promise.all([
          ctx.sdk.client.session
            .todo({ sessionID: record.session.id, directory })
            .then((result) => result.data ?? [])
            .catch(() => [] as Todo[]),
          ctx.sdk.client.session
            .diff({ sessionID: record.session.id, directory })
            .then((result) => result.data ?? [])
            .catch(() => [] as SnapshotFileDiff[]),
        ])
        return { record, todos, diffs }
      }),
    )
    return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
  })

  const insights = createMemo(() => resource.latest ?? [])

  const todos = createMemo<HomeTodoItem[]>(() =>
    insights()
      .flatMap((insight) =>
        insight.todos
          .filter((todo) => OPEN_TODO_STATUS.has(todo.status))
          .map((todo) => ({
            sessionID: insight.record.session.id,
            session: insight.record.session,
            sessionTitle: insight.record.session.title,
            projectName: insight.record.projectName,
            content: todo.content,
            status: todo.status,
            priority: todo.priority,
          })),
      )
      .slice(0, INSIGHT_TODO_LIMIT),
  )

  const changes = createMemo<HomeChangeItem[]>(() =>
    insights()
      .flatMap((insight) =>
        insight.diffs.flatMap((diff) => {
          if (!diff.file) return []
          return [
            {
              sessionID: insight.record.session.id,
              session: insight.record.session,
              sessionTitle: insight.record.session.title,
              projectName: insight.record.projectName,
              file: diff.file,
              additions: diff.additions,
              deletions: diff.deletions,
              status: diff.status,
            },
          ]
        }),
      )
      .slice(0, INSIGHT_CHANGE_LIMIT),
  )

  return {
    data: {
      todos,
      changes,
      loading: () => resource.loading,
      hasAny: () => todos().length > 0 || changes().length > 0,
    },
  }
}

export type HomeSessionInsights = ReturnType<typeof createHomeSessionInsights>
