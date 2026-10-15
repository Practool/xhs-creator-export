import { createHash } from 'node:crypto';
import { localTime } from './parser.js';
import type { Note } from './types.js';

/** Keep Unicode titles while respecting Windows and UTF-8 filesystem limits. */
export function safeFilename(value: string, maxBytes = 200): string {
  let name = value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  let shortened = '';
  for (const character of name) {
    if (Buffer.byteLength(shortened + character, 'utf8') > maxBytes) break;
    shortened += character;
  }
  name = shortened.replace(/[. ]+$/g, '') || '无标题';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
export function noteName(note: Note): string {
  if (note.artifactName) return safeFilename(note.artifactName);
  const time = localTime(note.listData?.post_time)?.replace(' ', '_').replace(/:/g, '-') ?? '发布时间未知';
  return safeFilename(time + '_' + (note.title || note.listData?.title || '无标题'), 180);
}
/** Assign as a group so duplicate titles/times cannot overwrite another note. */
export function assignNoteNames(notes: Note[]): void {
  const used = new Set<string>();
  for (const note of [...notes].sort((a, b) => a.id.localeCompare(b.id))) {
    let name = noteName(note);
    if (used.has(name.toLocaleLowerCase('en-US'))) {
      const suffix = createHash('sha256').update(note.id).digest('hex').slice(0, 12);
      name += '_' + suffix;
    }
    note.artifactName = name;
    used.add(name.toLocaleLowerCase('en-US'));
  }
}
