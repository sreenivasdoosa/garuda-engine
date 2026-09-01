/**
 * Markdown renderer for AI assistant answers — the model responds in GFM
 * (headings, **bold**, tables, ---, > quotes), so render it richly instead of
 * showing the raw syntax. react-markdown never injects raw HTML (safe against
 * anything the model echoes from logs/data); remark-gfm adds table support.
 * Styling is component-mapped to design-system tokens, scaled for a chat
 * bubble.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const AiMarkdown: React.FC<{ content: string }> = ({ content }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      h1: ({ children }) => <div className="mb-1.5 mt-3 text-base font-bold text-ink first:mt-0">{children}</div>,
      h2: ({ children }) => <div className="mb-1.5 mt-3 text-[15px] font-bold text-ink first:mt-0">{children}</div>,
      h3: ({ children }) => <div className="mb-1 mt-2.5 text-sm font-semibold text-ink first:mt-0">{children}</div>,
      h4: ({ children }) => <div className="mb-1 mt-2 text-sm font-semibold text-ink-soft first:mt-0">{children}</div>,
      p: ({ children }) => <p className="mb-1.5 leading-relaxed last:mb-0">{children}</p>,
      ul: ({ children }) => <ul className="mb-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
      ol: ({ children }) => <ol className="mb-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
      li: ({ children }) => <li className="leading-snug">{children}</li>,
      strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
      a: ({ children, href }) => (
        <a href={href} target="_blank" rel="noreferrer" className="text-primary-500 underline">
          {children}
        </a>
      ),
      hr: () => <hr className="my-2.5 border-hairline" />,
      blockquote: ({ children }) => (
        <blockquote className="my-1.5 border-l-2 border-primary-500/50 bg-primary-500/5 px-2.5 py-1 text-ink-soft">
          {children}
        </blockquote>
      ),
      code: ({ children, className }) =>
        className ? (
          // fenced block (language-*)
          <code className="block overflow-x-auto rounded bg-raised px-2 py-1.5 font-mono text-[11px] text-ink">
            {children}
          </code>
        ) : (
          <code className="rounded bg-raised px-1 py-0.5 font-mono text-[11px] text-ink">{children}</code>
        ),
      pre: ({ children }) => <pre className="my-1.5 overflow-x-auto">{children}</pre>,
      table: ({ children }) => (
        <div className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-xs">{children}</table>
        </div>
      ),
      thead: ({ children }) => <thead className="bg-raised text-left text-[11px] uppercase text-ink-faint">{children}</thead>,
      th: ({ children }) => <th className="border border-hairline px-2 py-1 font-medium">{children}</th>,
      td: ({ children }) => <td className="border border-hairline px-2 py-1 align-top">{children}</td>,
    }}
  >
    {content}
  </ReactMarkdown>
);

export default AiMarkdown;
