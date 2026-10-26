/*
 * Interrupt watching shared by the agent loop and chat: while a run is in
 * flight, stdin is read in raw mode and Esc (or Ctrl-C) aborts the run's
 * AbortController. A `paused` flag lets an interactive prompt (permission menu,
 * model picker) take the terminal back without eating its keystrokes.
 */

/** Watch stdin while a run is in flight: Esc (or Ctrl-C) aborts it. Returns a stop fn. */
export function watchInterrupt(controller: AbortController, paused: { value: boolean }, isTty: boolean): () => void {
  const stdin = process.stdin
  if (!isTty || !stdin.isTTY || typeof stdin.setRawMode !== 'function') return () => {}
  const onData = (b: Buffer): void => {
    if (paused.value) return
    const s = b.toString('utf8')
    if (s === '\x1b' || s === '\x03') controller.abort(new Error('interrupted by user'))
  }
  stdin.resume()
  try {
    stdin.setRawMode(true)
  } catch {
    return () => {}
  }
  stdin.on('data', onData)
  return () => {
    stdin.removeListener('data', onData)
    try {
      stdin.setRawMode(false)
    } catch {
      /* ignore */
    }
    stdin.pause()
  }
}
