import type { ReactNode } from 'react';

/**
 * Renders the model's small markdown subset (## headings, - bullets, **bold**, paragraphs) as React
 * elements. Nothing is injected as HTML, so model output can never become markup or script.
 */
function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
    );
}

export function ModelText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          {list.map((li, i) => (
            <li key={i}>{inline(li)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      flush();
      blocks.push(<h4 key={`h-${blocks.length}`}>{line.replace(/^#{1,4}\s+/, '')}</h4>);
    } else if (/^[-*•]\s/.test(line)) {
      list.push(line.replace(/^[-*•]\s+/, ''));
    } else {
      flush();
      blocks.push(<p key={`p-${blocks.length}`}>{inline(line)}</p>);
    }
  }
  flush();
  return <div className="ai-text text-[13.5px] leading-relaxed text-ink-muted">{blocks}</div>;
}
