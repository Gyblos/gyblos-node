// Small safe renderer for the local preview's text, lists and code blocks.
// React escapes content; no HTML or remote markup is injected.
import { Fragment } from 'react';

export function MessageText({ text }: { text: string }) {
  const sections = text.split(/(```[\s\S]*?(?:```|$))/g);
  return (
    <div className="reply-text">
      {sections.map((section, index) => {
        if (section.startsWith('```')) {
          const code = section.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
          return (
            <pre key={index}>
              <code>{code}</code>
            </pre>
          );
        }
        return (
          <Fragment key={index}>
            {section.split('\n').map((line, i) => {
              const content = line
                .split(/(\*\*.*?\*\*)/g)
                .map((part, j) =>
                  part.startsWith('**') && part.endsWith('**') ? (
                    <strong key={j}>
                      {part.slice('**'.length, -'**'.length)}
                    </strong>
                  ) : (
                    part
                  ),
                );
              if (line.startsWith('## '))
                return <h3 key={i}>{line.slice('## '.length)}</h3>;
              if (line.startsWith('- '))
                return (
                  <div className="reply-list-item" key={i}>
                    <span aria-hidden="true">·</span>
                    <span>
                      {line
                        .slice(2)
                        .split(/(\*\*.*?\*\*)/g)
                        .map((p, j) =>
                          p.startsWith('**') && p.endsWith('**') ? (
                            <strong key={j}>
                              {p.slice('**'.length, -'**'.length)}
                            </strong>
                          ) : (
                            p
                          ),
                        )}
                    </span>
                  </div>
                );
              return line ? <p key={i}>{content}</p> : null;
            })}
          </Fragment>
        );
      })}
    </div>
  );
}
