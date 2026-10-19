// The journal's small formatting language: **bold**, *italic* (or _italic_), "# Heading" lines,
// one paragraph per line, and "* * *" / "---" for a scene break. A port of the Android app's
// Markup.kt; both must behave the same.

const SCENE_BREAK = /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:#\s*){3,})$/;
const HEADING = /^\s*(#{1,3})\s+(.+)$/;
const isSpace = (c) => /\s/.test(c);
const isWordChar = (c) => /[\p{L}\p{N}]/u.test(c);

/** Formatting spans in source offsets: {start, end, style: 'bold' | 'italic' | 'marker'}. */
export function spans(text) {
  const out = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    let nl = text.indexOf('\n', lineStart);
    if (nl < 0) nl = text.length;
    if (!SCENE_BREAK.test(text.slice(lineStart, nl))) parse(text, lineStart, nl, out);
    lineStart = nl + 1;
  }
  return out;
}

function parse(t, from, to, out) {
  let i = from;
  while (i < to) {
    const c = t[i];
    if (c === '*' && i + 1 < to && t[i + 1] === '*') {
      const close = findClose(t, i + 2, to, '**');
      if (close > i + 2) {
        out.push({ start: i, end: i + 2, style: 'marker' }, { start: i + 2, end: close, style: 'bold' });
        parse(t, i + 2, close, out);
        out.push({ start: close, end: close + 2, style: 'marker' });
        i = close + 2;
      } else i += 2;
      continue;
    }
    if ((c === '*' || c === '_') && !(c === '_' && i > from && isWordChar(t[i - 1]))) {
      const close = findClose(t, i + 1, to, c);
      if (close > i + 1) {
        out.push({ start: i, end: i + 1, style: 'marker' }, { start: i + 1, end: close, style: 'italic' });
        parse(t, i + 1, close, out);
        out.push({ start: close, end: close + 1, style: 'marker' });
        i = close + 1;
        continue;
      }
    }
    i++;
  }
}

function findClose(t, start, to, marker) {
  if (start >= to || isSpace(t[start])) return -1;
  let j = start;
  while (j < to) {
    if (t.startsWith(marker, j)) {
      if (marker === '*' && j + 1 < to && t[j + 1] === '*') { j += 2; continue; }
      if (j > start && !isSpace(t[j - 1])) {
        if (marker === '_' && j + 1 < to && isWordChar(t[j + 1])) { j++; continue; }
        if (marker === '**' && j + 2 < to && t[j + 2] === '*') return j + 1;
        return j;
      }
    }
    j++;
  }
  return -1;
}

/** Text without formatting markers (previews, search). */
export function strip(text) {
  const markers = spans(text).filter((s) => s.style === 'marker').sort((a, b) => a.start - b.start);
  if (!markers.length) return text;
  let out = '', pos = 0;
  for (const m of markers) { if (m.start < pos) continue; out += text.slice(pos, m.start); pos = m.end; }
  return out + text.slice(pos);
}

/** Runs of text with formatting applied and markers removed: [{text, bold, italic}]. */
export function segments(text) {
  const ss = spans(text);
  const marker = new Uint8Array(text.length), bold = new Uint8Array(text.length), italic = new Uint8Array(text.length);
  for (const s of ss) for (let i = s.start; i < s.end; i++) (s.style === 'marker' ? marker : s.style === 'bold' ? bold : italic)[i] = 1;
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (marker[i]) continue;
    const last = out[out.length - 1];
    if (last && last.bold === !!bold[i] && last.italic === !!italic[i]) last.text += text[i];
    else out.push({ text: text[i], bold: !!bold[i], italic: !!italic[i] });
  }
  return out;
}

/** Book paragraphs: [{text, sceneBreak, indent, spaceBefore, heading}]. */
export function paragraphs(body) {
  const out = [];
  let blankBefore = false, afterBreak = true;
  for (const line of body.split('\n')) {
    if (!line.trim()) { blankBefore = out.length > 0; continue; }
    if (SCENE_BREAK.test(line)) {
      out.push({ text: '', sceneBreak: true, indent: false, spaceBefore: false, heading: 0 });
      afterBreak = true; blankBefore = false;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push({ text: h[2].trim(), sceneBreak: false, indent: false, spaceBefore: out.length > 0, heading: h[1].length });
      afterBreak = true; blankBefore = false;
      continue;
    }
    out.push({ text: line.trim(), sceneBreak: false, indent: !afterBreak && !blankBefore, spaceBefore: blankBefore && !afterBreak, heading: 0 });
    afterBreak = false; blankBefore = false;
  }
  return out;
}

/** Ctrl+B / Ctrl+I: wraps the selection in marker ('**' or '*'), or removes it if already wrapped. */
export function toggle(text, selStart, selEnd, marker) {
  let s = Math.max(0, Math.min(Math.min(selStart, selEnd), text.length));
  let e = Math.max(0, Math.min(Math.max(selStart, selEnd), text.length));
  const m = marker.length;
  if (s === e) return { text: text.slice(0, s) + marker + marker + text.slice(s), selStart: s + m, selEnd: s + m };
  while (s < e && isSpace(text[s])) s++;
  while (e > s && isSpace(text[e - 1])) e--;
  const before = text.slice(0, s), after = text.slice(e), inner = text.slice(s, e);
  const endsWithMarker = (str) => str.endsWith(marker) && (m === 2 || !str.endsWith('**') || str.endsWith('***'));
  const startsWithMarker = (str) => str.startsWith(marker) && (m === 2 || !str.startsWith('**') || str.startsWith('***'));
  if (endsWithMarker(before) && startsWithMarker(after)) {
    return { text: before.slice(0, -m) + inner + after.slice(m), selStart: s - m, selEnd: e - m };
  }
  if (inner.length >= 2 * m && startsWithMarker(inner) && endsWithMarker(inner)) {
    const unwrapped = inner.slice(m, inner.length - m);
    return { text: before + unwrapped + after, selStart: s, selEnd: s + unwrapped.length };
  }
  return { text: before + marker + inner + marker + after, selStart: s + m, selEnd: e + m };
}
