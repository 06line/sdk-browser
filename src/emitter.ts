// Emitter is the on(event, handler) of the phone and of its calls: on returns the function that removes the handler.
export class Emitter<Events extends Record<string, (...args: never[]) => void>> {
  private handlers: { [E in keyof Events]?: Set<Events[E]> } = {}

  on<E extends keyof Events>(event: E, handler: Events[E]): () => void {
    const set = (this.handlers[event] ??= new Set())
    set.add(handler)

    return () => set.delete(handler)
  }

  protected emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>) {
    for (const handler of this.handlers[event] ?? []) {
      try {
        ;(handler as (...a: Parameters<Events[E]>) => void)(...args)
      } catch (error) {
        console.error(`06line: a ${String(event)} handler threw`, error)
      }
    }
  }
}
