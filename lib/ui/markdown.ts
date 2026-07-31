/**
 * Tiny, dependency-free Markdown renderer for chat messages.
 *
 * It escapes HTML first (so model output can never inject markup), then applies
 * a safe subset: headings, bold, italic, inline code, code blocks, links,
 * bullet and numbered lists, and paragraphs. It also strips em dashes so the
 * text reads in a natural, non-robotic voice.
 *
 * Rendered only on FINALISED messages, never mid-stream, to avoid reflow.
 */

/** Replace em dashes (and stray em-dash-like sequences) with natural punctuation. */
export function deEmDash(s: string): string {
  return s
    .replace(/\s*—\s*/g, ", ")   // em dash → comma
    .replace(/\s*―\s*/g, ", ")   // horizontal bar → comma
    .replace(/\s+,\s/g, ", ");    // tidy any doubled spaces before comma
}

/** Tidy a messy paste so it reads cleanly: normalise tabs, strip trailing
 * spaces, and collapse big runs of blank lines. Keeps real structure intact. */
export function tidyPaste(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(s: string): string {
  let t = escapeHtml(s);
  // inline code first so its contents aren't further formatted
  t = t.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  // links [text](url) — only http(s)
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, txt, url) =>
    `<a href="${url}" target="_blank" rel="noreferrer" class="underline text-primary-300">${txt}</a>`);
  // bold then italic
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return t;
}

/** Convert a markdown string to a safe HTML string. */
export function renderMarkdown(src: string): string {
  const text = deEmDash(src || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const html: string[] = [];
  let i = 0;
  let inCode = false;
  let codeBuf: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType) { html.push(`</${listType}>`); listType = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (/^```/.test(line.trim())) {
      if (!inCode) { inCode = true; codeBuf = []; closeList(); }
      else {
        html.push(`<pre class="rounded-lg bg-surface-overlay/70 border border-border p-2.5 overflow-x-auto text-[12px]"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        inCode = false;
      }
      i++;
      continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }

    // blank line → paragraph break
    if (!line.trim()) { closeList(); i++; continue; }

    // headings → bold line (kept compact for chat)
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { closeList(); html.push(`<p class="font-semibold">${inline(h[2])}</p>`); i++; continue; }

    // bullet list
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (listType !== "ul") { closeList(); html.push('<ul class="list-disc pl-5 space-y-0.5">'); listType = "ul"; }
      html.push(`<li>${inline(bullet[1])}</li>`);
      i++;
      continue;
    }
    // numbered list
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (num) {
      if (listType !== "ol") { closeList(); html.push('<ol class="list-decimal pl-5 space-y-0.5">'); listType = "ol"; }
      html.push(`<li>${inline(num[1])}</li>`);
      i++;
      continue;
    }

    // normal paragraph (merge consecutive non-empty, non-list lines)
    closeList();
    const para: string[] = [line];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !/^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|```)/.test(lines[j])) {
      para.push(lines[j]);
      j++;
    }
    html.push(`<p>${inline(para.join(" "))}</p>`);
    i = j;
  }
  closeList();
  if (inCode && codeBuf.length) {
    html.push(`<pre class="rounded-lg bg-surface-overlay/70 border border-border p-2.5 overflow-x-auto text-[12px]"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  return html.join("\n");
}
