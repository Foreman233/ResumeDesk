import type { ReactNode } from 'react';

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/gu).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

const fence = /^ {0,3}`{3,}([^`]*)$/u;
const bullet = /^\s*(?:[-+*]|\d+[.)])\s+(.+)$/u;
const divider = /^\s*:?-{3,}:?\s*$/u;
function cells(line: string) { return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()); }
function isTable(line: string, next: string | undefined) {
  return line.includes('|') && !!next?.includes('|') && cells(next).length === cells(line).length && cells(next).every((cell) => divider.test(cell));
}

export function ChatMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const content: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const key = i;
    if (!line.trim()) { i++; continue; }
    if (fence.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !fence.test(lines[i]); i++) code.push(lines[i]);
      i++;
      content.push(<pre key={key}><code>{code.join('\n')}</code></pre>);
    } else if (isTable(line, lines[i + 1])) {
      const header = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      content.push(<div className="chat-table" key={key}><table>
        <thead><tr>{header.map((cell, n) => <th scope="col" key={n}>{inline(cell)}</th>)}</tr></thead>
        <tbody>{rows.map((row, n) => <tr key={n}>{header.map((_, j) => <td key={j}>{inline(row[j] ?? '')}</td>)}</tr>)}</tbody>
      </table></div>);
    } else if (bullet.test(line)) {
      const rows: string[] = [];
      const ordered = /^\s*\d/u.test(line);
      while (i < lines.length && bullet.test(lines[i]) && /^\s*\d/u.test(lines[i]) === ordered) rows.push(lines[i++].match(bullet)![1]);
      const items = rows.map((item, n) => <li key={n}>{inline(item)}</li>);
      content.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    } else {
      const heading = line.match(/^#{1,6}\s+(.+)$/u);
      if (heading) content.push(<h4 key={key}>{inline(heading[1])}</h4>);
      else {
        const block = [line];
        while (i + 1 < lines.length && lines[i + 1].trim() && !fence.test(lines[i + 1]) && !isTable(lines[i + 1], lines[i + 2])
          && !bullet.test(lines[i + 1]) && !/^#{1,6}\s/u.test(lines[i + 1])) block.push(lines[++i]);
        content.push(<p key={key}>{inline(block.join('\n'))}</p>);
      }
      i++;
    }
  }
  return <div className="chat-markdown">{content}</div>;
}
