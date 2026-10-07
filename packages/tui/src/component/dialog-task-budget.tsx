import { createResource, createSignal } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { useLanguage } from "../context/language"
import { useToast } from "../ui/toast"
import { TaskBudget } from "../util/task-budget"
import { cardText, taskText } from "../util/task-budget-text"
import { looksLikeEmail, normalizeCode, requestEmailCode, verifyEmailCode } from "../util/teai"

export function DialogTaskBudget(props: { client: TaskBudget.Client; session: string }) {
  const dialog = useDialog()
  const language = useLanguage()
  const toast = useToast()
  const { theme } = useTheme()
  const locale = language.current()
  const t = taskText(locale)
  const [busy, setBusy] = createSignal(false)
  const [tasks] = createResource(async () => props.client.list(props.session).then(
    (value) => ({ value, error: undefined }), (error: unknown) => ({ value: [], error }),
  ))
  const money = (n: number) => `${n.toLocaleString(locale)} cr`
  function home() { dialog.replace(() => <DialogTaskBudget {...props} />) }
  function fail(error: unknown) {
    const code = error instanceof TaskBudget.TaskError ? error.code : "unverified"
    toast.show({ variant: "error", message: `${t.failed}: ${code}`, duration: 8000 })
  }
  async function perform(action: () => Promise<unknown>) {
    if (busy()) return
    setBusy(true)
    try { await action() } catch (error) { fail(error) } finally { setBusy(false) }
  }
  function prompt(title: string, value = "") {
    return DialogPrompt.show(dialog, title, { value })
  }
  function choose(title: string, options: { title: string; value: string }[], message?: string) {
    return new Promise<string | undefined>((resolve) => {
      dialog.replace(() => <DialogSelect title={title} options={options} onSelect={(option) => resolve(option.value)}
        footer={message ? <text fg={theme.textMuted}>{message}</text> : undefined} />, () => resolve(undefined))
    })
  }
  async function login() {
    if (!props.session) { toast.show({ variant: "warning", message: t.needSession }); return }
    const email = await prompt(t.email)
    if (email === null) return
    if (!looksLikeEmail(email.trim())) throw new TaskBudget.TaskError("invalid_email")
    const sent = await requestEmailCode(email.trim())
    if (!sent.ok) throw new TaskBudget.TaskError("login_send_failed")
    toast.show({ variant: "info", message: t.sent })
    const code = await prompt(t.code)
    if (code === null) return
    if (!/^\d{6}$/.test(normalizeCode(code))) throw new TaskBudget.TaskError("invalid_code")
    const result = await verifyEmailCode(email.trim(), normalizeCode(code))
    if (!result.ok) throw new TaskBudget.TaskError("login_failed")
    props.client.login(result.token, props.session)
    home()
  }
  async function create() {
    if (!props.session) { toast.show({ variant: "warning", message: t.needSession }); return }
    if (!props.client.authorized(props.session)) { toast.show({ variant: "warning", message: t.needLogin }); return }
    const pricing = await props.client.pricing(props.session)
    if (pricing.currency !== "USD" || !pricing.models.includes("teai/decision-20b")) throw new TaskBudget.TaskError("price_changed")
    const goal = await prompt(t.goal)
    if (goal === null) return
    const criteria = await prompt(t.criteria)
    if (criteria === null) return
    if (!goal.trim() || !criteria.trim()) throw new TaskBudget.TaskError("invalid_task_card")
    const schedule = await choose(t.schedule, [{ title: t.once, value: "once" }, { title: t.recurring, value: "recurring" }])
    if (!schedule) return
    const interval = schedule === "recurring" ? await prompt(t.interval, "60") : "0"
    if (interval === null) return
    const duration = await prompt(t.duration, "10")
    if (duration === null) return
    const expiry = await prompt(t.expiry, "24")
    if (expiry === null) return
    const limit = await prompt(t.runLimit, String(pricing.default_run_limit / pricing.credits_per_usd))
    if (limit === null) return
    const monthly = schedule === "recurring" ? await prompt(t.monthLimit, limit) : limit
    if (monthly === null) return
    if (![interval, duration, expiry].every((s) => /^\d+$/.test(s) && Number.isSafeInteger(Number(s)))
      || Number(duration) < 1 || Number(duration) > 1440 || Number(expiry) < 1 || Number(expiry) > 744
      || (schedule === "recurring" && (Number(interval) < 1 || Number(interval) > 44640))) throw new TaskBudget.TaskError("invalid_task_card")
    const first = Date.now()
    const approval: TaskBudget.Approval = {
      id: crypto.randomUUID(), approval_id: crypto.randomUUID(), card: {
        goal: goal.trim(), criteria: criteria.split("\n").map((s) => s.trim()).filter(Boolean),
        scope: [t.scope], prohibited: [t.prohibited], stop_conditions: [t.stops], session_id: props.session,
        price_version: pricing.price_version, run_limit: TaskBudget.credits(limit, pricing.credits_per_usd),
        month_limit: TaskBudget.credits(monthly, pricing.credits_per_usd), duration_ms: Number(duration) * 60_000,
        interval_ms: schedule === "recurring" ? Number(interval) * 60_000 : null,
        first_at: first, expires_at: first + Number(expiry) * 3_600_000,
      },
    }
    if (approval.card.month_limit < approval.card.run_limit) throw new TaskBudget.TaskError("invalid_amount")
    // The final screen retains IDs and the exact snapshot on uncertain POSTs.
    dialog.replace(() => <TaskCardApproval approval={approval} client={props.client} session={props.session} locale={locale} onDone={home} />)
  }
  async function history(task: TaskBudget.Task) {
    const runs = await props.client.history(props.session, task.id)
    dialog.replace(() => <DialogSelect title={t.history} options={runs.map((run) => ({
      title: `${new Date(run.due_at).toLocaleString(locale)} · ${run.state}`, value: run.id,
      description: `${run.executor} · ${run.reason ?? ""} · ${t.spent} ${money(run.spent)} · ${t.reserved} ${money(run.reserved)}`,
      onSelect: () => { void perform(() => runDetail(task, run)) },
    }))} />)
  }
  async function runDetail(task: TaskBudget.Task, run: TaskBudget.Run) {
    const results = await props.client.results(props.session, run.id)
    const text = results.map((item) => item.response?.choices?.map((choice) => choice.message?.content ?? "").join("\n") ?? "").join("\n\n")
    const info = `${run.id}\n${t.state}: ${run.state} · ${t.reason}: ${run.reason ?? "—"}\n${t.spent}: ${money(run.spent)} · ${t.reserved}: ${money(run.reserved)}\n${run.evidence.join("\n")}`
    const choice = await choose(t.history, [
      { title: t.result, value: "result" },
      ...(["running", "waiting"].includes(run.state) ? [{ title: t.confirm, value: "confirm" }] : []),
      ...(run.state === "waiting" && run.reserved === 0 && run.deadline > Date.now() ? [{ title: t.resume, value: "resume" }] : []),
      { title: t.cancel, value: "back" },
    ], info)
    if (choice === "result") {
      dialog.replace(() => <box padding={1} gap={1}><text fg={theme.text}>{t.result}</text>
        <scrollbox height={18}><text fg={theme.text}>{text || t.noResult}</text></scrollbox>
        <text fg={theme.textMuted}>{info}</text></box>)
    }
    if (choice === "confirm") {
      const evidence = await prompt(`${t.evidence}\n${task.card.criteria.join("\n")}`)
      if (evidence === null) return
      const lines = evidence.split("\n").map((s) => s.trim())
      if (lines.length !== task.card.criteria.length || lines.some((s) => !s)) throw new TaskBudget.TaskError("evidence_required")
      const accepted = await choose(t.confirm, [{ title: t.cancel, value: "cancel" }, { title: t.confirm, value: "confirm" }], `${info}\n\n${lines.join("\n")}`)
      if (accepted !== "confirm") return
      await props.client.confirm(props.session, run.id, lines)
      home()
    }
    if (choice === "resume") {
      const instruction = await prompt(t.instruction)
      if (!instruction?.trim()) return
      await props.client.resume(props.session, task, run, "teai/decision-20b", instruction)
      await history(task)
    }
    if (choice === "back") await history(task)
  }
  function detail(task: TaskBudget.Task) {
    const info = `${cardText(task.card, locale)}\n\n${t.state}: ${task.state}\n${t.spent}: ${money(task.spent)} · ${t.reserved}: ${money(task.reserved)}\n${t.month}: ${money(task.month_spent)} + ${money(task.month_reserved)} / ${money(task.card.month_limit)}\n${t.next}: ${new Date(task.next_at).toLocaleString(locale)}`
    dialog.replace(() => <DialogSelect title={task.card.goal} footer={<scrollbox height={14}><text fg={theme.textMuted}>{info}</text></scrollbox>} options={[
      { title: t.history, value: "history", onSelect: () => { void perform(() => history(task)) } },
      { title: props.client.isArmed(task.id) ? t.disarm : t.arm, value: "arm", onSelect: () => {
        void perform(async () => {
          if (props.client.isArmed(task.id)) props.client.disarm(task.id)
          else props.client.arm(props.session, task)
          home()
        })
      } },
      { title: t.stop, value: "stop", onSelect: () => { void perform(async () => {
        const accepted = await choose(t.stop, [{ title: t.cancel, value: "cancel" }, { title: t.stop, value: "stop" }], task.card.goal)
        if (accepted !== "stop") return
        await props.client.stop(props.session, task.id)
        home()
      }) } },
      { title: t.cancel, value: "back", onSelect: home },
    ]} />)
  }
  return <DialogSelect title={t.title} locked={busy()} options={[
    { title: t.login, value: "login", onSelect: () => { void perform(login) } },
    { title: t.create, value: "new", onSelect: () => { void perform(create) } },
    { title: t.refresh, value: "refresh", onSelect: home },
    ...(tasks()?.value ?? []).map((task) => ({
      title: task.card.goal, value: task.id,
      description: `${task.state} · ${t.spent} ${money(task.spent)} · ${t.reserved} ${money(task.reserved)} · ${props.client.isArmed(task.id) ? t.armed : t.paused}`,
      onSelect: () => detail(task),
    })),
  ]} footer={<text fg={theme.textMuted}>{tasks.loading ? t.loading : tasks()?.error ? `${t.failed}: ${tasks()?.error instanceof TaskBudget.TaskError ? (tasks()?.error as TaskBudget.TaskError).code : t.unknown}` : t.boundary}</text>} />
}

export function TaskCardApproval(props: { approval: TaskBudget.Approval; client: TaskBudget.Client; session: string; locale: string; onDone: () => void }) {
  const { theme } = useTheme()
  const t = taskText(props.locale)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  return <DialogSelect title={t.card} locked={busy()} options={[
    { title: t.cancel, value: "cancel", onSelect: props.onDone },
    { title: t.approve, value: "approve", onSelect: () => {
      if (busy()) return
      setBusy(true)
      props.client.approve(props.session, props.approval).then(props.onDone).catch((error: unknown) => {
        setError(`${t.failed}: ${error instanceof TaskBudget.TaskError ? error.code : t.unknown}`)
      }).finally(() => setBusy(false))
    } },
  ]} footer={<box gap={1}><scrollbox height={18}><text fg={theme.text}>{cardText(props.approval.card, props.locale)}</text></scrollbox>
    <text fg={theme.error}>{error()}</text><text fg={theme.textMuted}>{busy() ? t.loading : ""}</text></box>} />
}
