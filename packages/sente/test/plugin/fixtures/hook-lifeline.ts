// Child process for config-hooks tests: runs one hook through the real runner, in the mode given by argv.
//   hang <pidfile>    start a long hook that writes its process group id, then wait to be killed
//   sighup            run a short hook, then send SIGHUP to itself; prints "alive" if it survives (nohup)
//   worker <pidfile>  same as hang, but inside a Worker that the main thread then shuts down like the TUI does
//                     (a "shutdown" message, which kills running hooks, then terminate())
import { isMainThread, parentPort, Worker, workerData } from "worker_threads"
import { ConfigHooksRunner } from "../../../src/plugin/config-hooks"

const mode = isMainThread ? process.argv[2] : "hang"
const pidfile = isMainThread ? process.argv[3] : workerData

if (mode === "hang") {
  parentPort?.on("message", () => {
    ConfigHooksRunner.killAll()
    parentPort?.postMessage("done")
  })
  void ConfigHooksRunner.exec(
    `echo $$ > ${pidfile}; sleep 30 & echo $! > ${pidfile}.sleep; wait`,
    {},
    { cwd: process.cwd(), timeout: 60 },
  )
  setInterval(() => {}, 1000)
}

if (mode === "sighup") {
  await ConfigHooksRunner.exec("true", {}, { cwd: process.cwd() })
  process.kill(process.pid, "SIGHUP")
  await Bun.sleep(300)
  console.log("alive")
  process.exit(0)
}

if (mode === "worker") {
  const worker = new Worker(new URL(import.meta.url), { workerData: pidfile })
  while (!(await Bun.file(`${pidfile}.sleep`).exists())) await Bun.sleep(50)
  await Bun.sleep(100)
  const done = new Promise((resolve) => worker.once("message", resolve))
  worker.postMessage("shutdown")
  await done
  await worker.terminate()
  console.log("terminated")
  setInterval(() => {}, 1000)
}
