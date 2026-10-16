// Test preload: polyfill browser APIs that OpenTUI 0.6.3 no longer installs globally.
// OpenTUI 0.4.5 replaced `global.requestAnimationFrame` with the renderer's implementation,
// but 0.6.3 requires it to exist in the environment. Bun does not provide it.
if (typeof globalThis.requestAnimationFrame !== "function") {
  let rafId = 0
  const rafTimers = new Map<number, ReturnType<typeof setTimeout>>()
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = ++rafId
    const timer = setTimeout(() => {
      rafTimers.delete(id)
      callback(Date.now())
    }, 0)
    rafTimers.set(id, timer)
    return id
  }
  globalThis.cancelAnimationFrame = (id: number): void => {
    const timer = rafTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      rafTimers.delete(id)
    }
  }
}

export {}
