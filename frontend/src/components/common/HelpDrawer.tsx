import { createPortal } from 'react-dom';
import { BsArrowLeft, BsExclamationTriangleFill, BsLink45Deg } from 'react-icons/bs';
import { useHelpStore } from '@/store/helpStore';
import type { HelpArticle } from '@/types/help';

// Right-side help drawer. Migrated off react-bootstrap Offcanvas to an inline
// token-driven drawer (used once, in ConsoleLayout).
interface HelpDrawerProps {
  contentMap: Record<string, HelpArticle>;
}

/** Renders basic inline formatting: **bold**, `code`, and \n line breaks */
const FormattedText: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\n)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part === '\n') return <br key={i} />;
        if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
        if (part.startsWith('`') && part.endsWith('`'))
          return (
            <code key={i} className="rounded bg-raised px-1 text-ink">
              {part.slice(1, -1)}
            </code>
          );
        return <span key={i}>{part}</span>;
      })}
    </>
  );
};

const HelpDrawer: React.FC<HelpDrawerProps> = ({ contentMap }) => {
  const { isOpen, activeArticle, history, closeHelp, navigateTo, goBack } = useHelpStore();

  const handleRelatedClick = (fieldKey: string) => {
    const article = contentMap[fieldKey];
    if (article) navigateTo(article);
  };

  if (!isOpen) return null;

  // Portaled to <body> and stacked above the modal layer (z-[1100]) so a "?"
  // clicked inside a modal opens a readable drawer on top of it, immune to any
  // ancestor stacking context.
  return createPortal(
    <>
      <div className="fixed inset-0 z-[1150] bg-black/40" onClick={closeHelp} />
      <aside className="fixed right-0 top-0 z-[1160] flex h-full w-full max-w-[500px] flex-col border-l border-hairline bg-card text-ink shadow-card-dark">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-hairline p-4">
          {history.length > 0 && (
            <BsArrowLeft size={18} className="shrink-0 cursor-pointer text-ink-faint hover:text-ink" onClick={goBack} />
          )}
          <div className="min-w-0 flex-grow">
            <h6 className="mb-0 font-display text-base font-bold text-ink">{activeArticle?.title}</h6>
            {activeArticle?.category && (
              <span className="mt-1 inline-flex rounded-full bg-raised px-2 py-0.5 text-xs text-ink-soft">
                {activeArticle.category}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={closeHelp}
            aria-label="Close"
            className="shrink-0 rounded p-1 text-lg leading-none text-ink-faint hover:bg-raised hover:text-ink"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeArticle && (
            <div className="flex flex-col gap-3">
              {/* Description */}
              <div>
                {activeArticle.description.map((para, i) => (
                  <p key={i} className="mb-2 text-sm text-ink-soft" style={{ lineHeight: 1.6 }}>
                    <FormattedText text={para} />
                  </p>
                ))}
              </div>

              {/* Warning */}
              {activeArticle.warning && (
                <div className="flex gap-2 rounded-card border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-ink">
                  <BsExclamationTriangleFill className="mt-1 shrink-0 text-warning-500" />
                  <span>
                    <FormattedText text={activeArticle.warning} />
                  </span>
                </div>
              )}

              {/* Default Value */}
              {activeArticle.defaultValue && (
                <div>
                  <h6 className="mb-1 text-sm font-bold text-ink-faint">Default</h6>
                  <code className="rounded bg-raised px-2 py-1 text-sm text-ink">{activeArticle.defaultValue}</code>
                </div>
              )}

              {/* Valid Values */}
              {activeArticle.validValues && activeArticle.validValues.length > 0 && (
                <div>
                  <h6 className="mb-1 text-sm font-bold text-ink-faint">Valid Values</h6>
                  <ul className="mb-0 list-none pl-0">
                    {activeArticle.validValues.map((v) => (
                      <li key={v} className="mb-1 text-sm text-ink-soft" style={{ lineHeight: 1.6 }}>
                        <FormattedText text={v} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Example */}
              {activeArticle.example && (
                <div>
                  <h6 className="mb-1 text-sm font-bold text-ink-faint">{activeArticle.example.title}</h6>
                  <div className="rounded bg-raised p-2 text-sm text-ink" style={{ lineHeight: 1.6 }}>
                    <FormattedText text={activeArticle.example.content} />
                  </div>
                </div>
              )}

              {/* Related Fields */}
              {activeArticle.relatedFields && activeArticle.relatedFields.length > 0 && (
                <div>
                  <h6 className="mb-1 flex items-center gap-1 text-sm font-bold text-ink-faint">
                    <BsLink45Deg /> Related Fields
                  </h6>
                  <div className="flex flex-wrap gap-1">
                    {activeArticle.relatedFields.map((key) => {
                      const related = contentMap[key];
                      return (
                        <button
                          key={key}
                          type="button"
                          disabled={!related}
                          onClick={() => related && handleRelatedClick(key)}
                          className="rounded-full border border-primary-500/30 bg-primary-500/10 px-2 py-0.5 text-xs text-primary-500 enabled:hover:bg-primary-500/20 disabled:cursor-default disabled:opacity-70"
                        >
                          {related?.title || key}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
};

export default HelpDrawer;
