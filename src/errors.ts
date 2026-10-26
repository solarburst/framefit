export class StartupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StartupError"
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
