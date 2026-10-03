// Ссылки в свободном тексте (комментарии, заметки, расшифровки): найти и подписать коротко.

export type TextPart = { text: string } | { url: string; label: string };

const URL_RE = /https?:\/\/[^\s<>«»"]+/g;

/** Текст кусками: обычный текст и ссылки. Знак препинания в конце — не часть ссылки. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0].replace(/[.,;:!?…]+$/, '');
    // Закрывающая скобка — своя, только если в ссылке есть открывающая: «(см. https://…)».
    if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1);
    let label: string;
    try {
      label = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ url, label });
    last = match.index + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
