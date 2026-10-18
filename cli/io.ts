export interface Io {
  out(s: string): void;
  err(s: string): void;
}

export const processIo: Io = {
  out: (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n"),
  err: (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n"),
};

/** Collects output, for tests. */
export function memoryIo(): Io & { stdout: string[]; stderr: string[]; text(): string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (s) => void stdout.push(s),
    err: (s) => void stderr.push(s),
    text: () => [...stdout, ...stderr].join("\n"),
  };
}
