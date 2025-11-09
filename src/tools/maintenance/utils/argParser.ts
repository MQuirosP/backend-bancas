export interface ParsedArgs {
  command: string | null;
  flags: Record<string, string | boolean>;
}

const KEY_PREFIX = /^(--?)([A-Za-z0-9-_]+)$/;

export function parseArgs(argv: string[]): ParsedArgs {
  const [, , ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    const match = KEY_PREFIX.exec(token);
    if (!match) {
      positional.push(token);
      continue;
    }

    const key = match[2];
    const next = rest[i + 1];
    if (!next || KEY_PREFIX.test(next)) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    i += 1;
  }

  const command = positional[0] ?? (flags["task"] as string | undefined) ?? null;

  return { command, flags };
}

export function requireFlag<T extends string>(
  flags: Record<string, string | boolean>,
  name: T
): string {
  const value = flags[name];
  if (!value || typeof value !== "string") {
    throw new Error(`Falta el parámetro --${name}`);
  }
  return value;
}

export function optionalFlag(
  flags: Record<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagAsBoolean(
  flags: Record<string, string | boolean>,
  name: string
): boolean {
  const value = flags[name];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["1", "true", "yes", "si"].includes(value.toLowerCase());
  }
  return false;
}


