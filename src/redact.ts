/**
 * Strip URLs and bearer tokens from any diagnostic text that is handed back to
 * a client. Upstream error messages, bodies, and status lines can carry signed
 * URLs or leaked credentials, so every such surface gets this pass.
 */
export function redactDiagnostics(text: string): string {
  return text
    .replace(/https?:\/\/[^\s)"']+/g, "[url]")
    .replace(/bearer\s+[^\s]+/gi, "Bearer [redacted]");
}
