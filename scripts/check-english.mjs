import { execFileSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
const matches = [];
let checked = 0;
for (const file of files) {
  let metadata;
  try { metadata = await lstat(resolve(root, file)); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (!metadata.isFile()) continue;
  const bytes = await readFile(resolve(root, file));
  if (bytes.includes(0)) continue;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { continue; }
  checked++;
  if (/\p{Script=Han}/u.test(file)) matches.push(`${file}: filename`);
  text.split(/\r?\n/).forEach((line, index) => {
    if (/\p{Script=Han}/u.test(line)) matches.push(`${file}:${index + 1}`);
  });
}
if (matches.length) {
  console.error(`Han characters found in project-owned text:\n${matches.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`PASS: ${checked} project-owned text files checked; no Han characters. Dependencies, Git history, and ignored local artifacts are excluded.`);
}
