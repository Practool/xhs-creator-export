import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { Config } from './types.js';

const schema = z.object({
  browser: z.enum(['auto', 'chrome', 'chromium']).default('auto'),
  profileDir: z.string().min(1).default('.xhs-creator-export/profile'),
  outputDir: z.string().min(1).default('.xhs-creator-export/jobs'),
  databasePath: z.string().min(1).default('.xhs-creator-export/tasks.sqlite'),
  headless: z.boolean().default(false), dateStrategy: z.literal('platform').default('platform'),
  intervalMs: z.number().int().min(0).max(60000).default(2000),
  operationTimeoutMs: z.number().int().min(1000).max(300000).default(30000),
  downloadTimeoutMs: z.number().int().min(1000).max(300000).default(60000),
  stepRetries: z.number().int().min(0).max(5).default(2),
  noteRestarts: z.number().int().min(0).max(2).default(1),
}).strict();
export const defaults = schema.parse({});
export function resolveConfig(value: unknown, filename: string): Config {
  const config = schema.parse(value);
  const base = path.dirname(path.resolve(filename));
  const profileDir = path.resolve(base, config.profileDir);
  const home = os.homedir();
  const daily = [path.join(home, 'Library/Application Support/Google/Chrome'), path.join(home, '.config/google-chrome'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data')].filter(Boolean) as string[];
  if (daily.some(dir => profileDir === dir || profileDir.startsWith(dir + path.sep))) throw new Error('请使用独立目录，不能自动化日常 Chrome 用户目录');
  return { ...config, profileDir,
    outputDir: path.resolve(base, config.outputDir), databasePath: path.resolve(base, config.databasePath) };
}
export async function loadConfig(filename: string): Promise<Config> {
  return resolveConfig(parse(await fs.readFile(filename, 'utf8')), filename);
}
export async function initConfig(filename: string): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(filename)), { recursive: true });
  await fs.writeFile(filename, '# xhs-creator-export configuration; paths are relative to this file\n' + stringify(defaults), { flag: 'wx' });
}
export function dateRange(from?: string, to?: string): [string, string] | undefined {
  if (!from && !to) return;
  if (!from || !to) throw new Error('--from 和 --to 必须同时提供');
  for (const value of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value)
      throw new Error('日期必须为有效 YYYY-MM-DD：' + value);
  }
  if (from > to) throw new Error('起始日期不能晚于结束日期');
  return [from, to];
}
