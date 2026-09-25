import { readFile } from 'node:fs/promises';

/** File-backed secrets keep credentials out of the container environment. */
export async function secretSetting(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const inline = env[name];
  const path = env[`${name}_FILE`];
  if (inline !== undefined && path !== undefined) throw new Error(`Set only one of ${name} or ${name}_FILE`);
  if (path !== undefined) {
    if (!path) throw new Error(`${name}_FILE must name a file`);
    const value = (await readFile(path, 'utf8')).replace(/\r?\n$/, '');
    if (!value || /[\r\n\0]/.test(value)) throw new Error(`${name}_FILE must contain one nonempty line`);
    return value;
  }
  return inline || undefined;
}

export async function requiredSecret(name: string): Promise<string> {
  const value = await secretSetting(name);
  if (!value) throw new Error(`${name} or ${name}_FILE is required`);
  return value;
}
