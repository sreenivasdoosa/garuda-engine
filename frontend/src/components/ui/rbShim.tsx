/**
 * react-bootstrap → Tailwind-token shim.
 *
 * Drop-in replacements for the subset of the react-bootstrap API used by the
 * large, highly-repetitive admin pages, so those files can migrate by swapping
 * their react-bootstrap import line for this module (same named exports),
 * with the JSX body left byte-identical (the documented "local-token-shim"
 * technique, promoted to a shared module for the giant CRUD pages).
 *
 * Components render token surfaces; layout/spacing utility classNames on the
 * bodies (d-flex, text-muted, mb-3, …) still resolve against bootstrap.min.css
 * during coexistence. In Phase 4 (Bootstrap removed) files on this shim need a
 * utility-class sweep — tracked in the migration doc.
 *
 * eslint-disable @typescript-eslint/no-explicit-any -- deliberate loose typing to mirror the RB API
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { ReactNode, ReactElement, createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Spinner as UISpinner } from './Spinner';
import { Badge as UIBadge, type Tone } from './Badge';
import { Tooltip as UITooltip } from './Tooltip';

type P = { className?: string; children?: ReactNode; [k: string]: any };

const CTRL =
  'w-full rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:bg-raised disabled:opacity-70';

// ---------------------------------------------------------------- Row / Col
export const Row = ({ className = '', children, ...p }: P) => (
  <div className={`flex flex-wrap -mx-2 ${className}`} {...p}>{children}</div>
);
// Literal per-breakpoint width classes (n/12) — MUST be literal strings so
// Tailwind's JIT scanner emits them (dynamically-built `w-${x}` would not).
const COLW: Record<'xs' | 'sm' | 'md' | 'lg' | 'xl', Record<number, string>> = {
  xs: { 1: 'w-1/12', 2: 'w-1/6', 3: 'w-1/4', 4: 'w-1/3', 5: 'w-5/12', 6: 'w-1/2', 7: 'w-7/12', 8: 'w-2/3', 9: 'w-3/4', 10: 'w-5/6', 11: 'w-11/12', 12: 'w-full' },
  sm: { 1: 'sm:w-1/12', 2: 'sm:w-1/6', 3: 'sm:w-1/4', 4: 'sm:w-1/3', 5: 'sm:w-5/12', 6: 'sm:w-1/2', 7: 'sm:w-7/12', 8: 'sm:w-2/3', 9: 'sm:w-3/4', 10: 'sm:w-5/6', 11: 'sm:w-11/12', 12: 'sm:w-full' },
  md: { 1: 'md:w-1/12', 2: 'md:w-1/6', 3: 'md:w-1/4', 4: 'md:w-1/3', 5: 'md:w-5/12', 6: 'md:w-1/2', 7: 'md:w-7/12', 8: 'md:w-2/3', 9: 'md:w-3/4', 10: 'md:w-5/6', 11: 'md:w-11/12', 12: 'md:w-full' },
  lg: { 1: 'lg:w-1/12', 2: 'lg:w-1/6', 3: 'lg:w-1/4', 4: 'lg:w-1/3', 5: 'lg:w-5/12', 6: 'lg:w-1/2', 7: 'lg:w-7/12', 8: 'lg:w-2/3', 9: 'lg:w-3/4', 10: 'lg:w-5/6', 11: 'lg:w-11/12', 12: 'lg:w-full' },
  xl: { 1: 'xl:w-1/12', 2: 'xl:w-1/6', 3: 'xl:w-1/4', 4: 'xl:w-1/3', 5: 'xl:w-5/12', 6: 'xl:w-1/2', 7: 'xl:w-7/12', 8: 'xl:w-2/3', 9: 'xl:w-3/4', 10: 'xl:w-5/6', 11: 'xl:w-11/12', 12: 'xl:w-full' },
};
// Bootstrap col-auto = flex: 0 0 auto; width: auto (content-sized column).
const COLAUTO: Record<'xs' | 'sm' | 'md' | 'lg' | 'xl', string> = {
  xs: 'w-auto flex-none',
  sm: 'sm:w-auto sm:flex-none',
  md: 'md:w-auto md:flex-none',
  lg: 'lg:w-auto lg:flex-none',
  xl: 'xl:w-auto xl:flex-none',
};
const toNum = (v: any): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
const colCls = (bp: 'xs' | 'sm' | 'md' | 'lg' | 'xl', v: any): string | undefined => {
  if (v === 'auto') return COLAUTO[bp];
  const n = toNum(v);
  return n !== undefined ? COLW[bp][n] : undefined;
};
export const Col = ({ xs, sm, md, lg, xl, className = '', children, ...p }: P & { xs?: any; sm?: any; md?: any; lg?: any; xl?: any }) => {
  const b = { xs: colCls('xs', xs), sm: colCls('sm', sm), md: colCls('md', md), lg: colCls('lg', lg), xl: colCls('xl', xl) };
  const hasAny = Object.values(b).some((v) => v !== undefined);
  const parts = ['px-2', 'min-w-0'];
  if (!hasAny) {
    parts.push('flex-1'); // bare <Col> = equal-width flex column (Bootstrap default)
  } else {
    parts.push(b.xs ?? 'w-full'); // base full-width unless xs given
    if (b.sm !== undefined) parts.push(b.sm);
    if (b.md !== undefined) parts.push(b.md);
    if (b.lg !== undefined) parts.push(b.lg);
    if (b.xl !== undefined) parts.push(b.xl);
  }
  return <div className={`${parts.join(' ')} ${className}`} {...p}>{children}</div>;
};

// ---------------------------------------------------------------- Card
// Bootstrap-parity hover: subtle lift + shadow + an accent gradient top-line
// (the `::before` bar the old .card had). `no-hover` in className opts out.
const CARD_HOVER =
  'relative transition-[transform,box-shadow] duration-300 hover:-translate-y-1 hover:shadow-card before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:rounded-t-card before:bg-accent-gradient before:opacity-0 before:transition-opacity hover:before:opacity-100';
const CardBase = ({ bg, className = '', children, ...p }: P & { bg?: string }) => (
  <div className={`rounded-card border border-hairline mb-3 ${bg === 'light' ? 'bg-raised' : 'bg-card'} ${className.includes('no-hover') ? '' : CARD_HOVER} ${className}`} {...p}>{children}</div>
);
const CardHeader = ({ className = '', children, ...p }: P) => (
  <div className={`rounded-t-card border-b border-hairline bg-raised/50 px-4 py-3 font-semibold text-ink ${className}`} {...p}>{children}</div>
);
const CardBody = ({ className = '', children, ...p }: P) => (
  <div className={`p-3 ${className}`} {...p}>{children}</div>
);
const CardFooter = ({ className = '', children, ...p }: P) => (
  <div className={`border-t border-hairline p-3 ${className}`} {...p}>{children}</div>
);
export const Card = Object.assign(CardBase, { Header: CardHeader, Body: CardBody, Footer: CardFooter });

// ---------------------------------------------------------------- Table
export const Table = ({ className = '', children, striped: _s, hover: _h, responsive: _r, size: _sz, bordered: _b, borderless: _bl, ...p }: P & { striped?: boolean; hover?: boolean; responsive?: boolean; size?: string; bordered?: boolean; borderless?: boolean }) => (
  <div className="overflow-x-auto">
    <table
      className={`w-full text-sm [&_thead_th]:bg-raised [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:text-ink-faint [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle [&_td]:text-ink [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline hover:[&_tbody_tr]:bg-raised/40 ${className}`}
      {...p}
    >
      {children}
    </table>
  </div>
);

// ---------------------------------------------------------------- Badge
const bgToTone: Record<string, Tone> = {
  primary: 'primary', secondary: 'neutral', success: 'success', danger: 'danger',
  warning: 'warning', info: 'info', light: 'neutral', dark: 'neutral', blue: 'blue',
};
export const Badge = ({ bg = 'secondary', text: _t, className = '', children }: P & { bg?: string; text?: string }) => (
  <UIBadge tone={bgToTone[bg] ?? 'neutral'} className={className}>{children}</UIBadge>
);

// ---------------------------------------------------------------- Button
// Faithful map of RB variants → token styles (solid + colored outlines), so
// table action buttons keep Bootstrap's colour semantics (edit=primary,
// delete=danger, activate=success, …) instead of collapsing to one grey style.
const BTN_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50';
const btnVariants: Record<string, string> = {
  primary: 'bg-primary-600 text-white hover:bg-primary-700',
  secondary: 'bg-transparent text-ink border border-hairline hover:bg-raised hover:border-primary-500/50',
  success: 'bg-success-600 text-white hover:bg-success-700',
  danger: 'bg-danger-600 text-white hover:bg-danger-700',
  warning: 'bg-warning-500 text-black hover:bg-warning-600',
  info: 'bg-accent-500 text-white hover:bg-accent-600',
  light: 'bg-raised text-ink hover:bg-hairline',
  dark: 'bg-ink text-app hover:opacity-90',
  // Light-mode outline text uses the darker 600/700 shade — the 500s (esp. lab's
  // green #2dce89) sit under 4.5:1 on white cards and read washed-out.
  'outline-primary': 'border border-primary-600 text-primary-700 dark:border-primary-500 dark:text-primary-400 hover:bg-primary-500/10',
  'outline-secondary': 'border border-hairline text-ink hover:bg-raised',
  'outline-danger': 'border border-danger-500 text-danger-600 dark:text-danger-400 hover:bg-danger-500/10',
  'outline-success': 'border border-success-600 text-success-700 dark:border-success-500 dark:text-success-400 hover:bg-success-500/10',
  'outline-warning': 'border border-warning-600 text-warning-700 dark:border-warning-500 dark:text-warning-400 hover:bg-warning-500/10',
  'outline-info': 'border border-accent-600 text-accent-600 dark:border-accent-500 dark:text-accent-400 hover:bg-accent-500/10',
  'outline-dark': 'border border-hairline text-ink hover:bg-raised',
  link: 'text-primary-500 hover:underline',
};
const btnSizes: Record<string, string> = { sm: 'px-2.5 py-1 text-xs', md: 'px-3.5 py-1.5 text-sm', lg: 'px-4 py-2 text-base' };
export const Button = ({ variant = 'primary', size, type = 'button', className = '', children, onClick, ...p }: P & { variant?: string; size?: string; type?: any; onClick?: React.MouseEventHandler<HTMLButtonElement> }) => (
  <button type={type} onClick={onClick} className={`${BTN_BASE} ${btnVariants[variant] ?? btnVariants.primary} ${btnSizes[size ?? 'md'] ?? btnSizes.md} ${className}`} {...p}>
    {children}
  </button>
);

// ---------------------------------------------------------------- Spinner
export const Spinner = ({ size, animation: _a, variant: _v, className = '' }: P & { size?: string; animation?: string; variant?: string }) => (
  <UISpinner size={size === 'sm' ? 'sm' : 'md'} className={`text-primary-500 ${className}`} />
);

// ---------------------------------------------------------------- Alert
const alertTones: Record<string, string> = {
  info: 'border-accent-500/30 bg-accent-500/10 text-ink',
  primary: 'border-primary-500/30 bg-primary-500/10 text-ink',
  success: 'border-success-500/30 bg-success-500/10 text-ink',
  warning: 'border-warning-500/30 bg-warning-500/10 text-ink',
  danger: 'border-danger-500/30 bg-danger-500/10 text-danger-600 dark:text-danger-400',
};
const AlertBase = ({ variant = 'info', className = '', children, ...p }: P & { variant?: string }) => (
  <div className={`mb-3 rounded border px-3 py-2 text-sm ${alertTones[variant] ?? alertTones.info} ${className}`} {...p}>{children}</div>
);
const AlertHeading = ({ className = '', children, ...p }: P) => (
  <h5 className={`mb-1 font-semibold ${className}`} {...p}>{children}</h5>
);
const AlertLink = ({ className = '', children, ...p }: P) => (
  <a className={`underline ${className}`} {...p}>{children}</a>
);
export const Alert = Object.assign(AlertBase, { Heading: AlertHeading, Link: AlertLink });

// ---------------------------------------------------------------- Form family
const FormBase = ({ className = '', children, onSubmit, ...p }: P) => (
  <form
    className={className}
    onSubmit={(e) => {
      if (onSubmit) onSubmit(e);
      else e.preventDefault();
    }}
    {...p}
  >
    {children}
  </form>
);
const FormGroup = ({ className = '', children, controlId: _c, ...p }: P & { controlId?: string }) => (
  <div className={className} {...p}>{children}</div>
);
const FormLabel = ({ className = '', children, ...p }: P) => (
  <label className={`mb-1 block text-sm font-medium text-ink ${className}`} {...p}>{children}</label>
);
type ControlChange = React.ChangeEventHandler<HTMLInputElement & HTMLTextAreaElement>;
const FormControlBase = ({ as, className = '', onChange, isInvalid, plaintext: _pt, ...p }: P & { as?: string; onChange?: ControlChange; isInvalid?: boolean; plaintext?: boolean }) => {
  // `is-invalid` is an unstyled MARKER class: Feedback below shows itself only
  // when a preceding sibling carries it (react-bootstrap's CSS contract).
  const cls = `${CTRL} ${isInvalid ? 'border-danger-500 focus:border-danger-500 is-invalid' : ''} ${className}`;
  if (as === 'textarea') return <textarea className={cls} onChange={onChange as any} {...p} />;
  return <input className={cls} onChange={onChange as any} {...p} />;
};
// RB's Form.Control.Feedback: token danger text, HIDDEN until a preceding
// sibling control carries the `is-invalid` marker (FormControl adds it when
// isInvalid) — faithful to react-bootstrap, where feedback with static children
// only shows for invalid fields. w-full makes it wrap below inside InputGroups.
const FormControlFeedback = ({ type: _t, className = '', children, ...p }: P & { type?: string }) =>
  children ? <div className={`hidden [.is-invalid~&]:block mt-1 w-full text-xs text-danger-500 ${className}`} {...p}>{children}</div> : null;
const FormControl = Object.assign(FormControlBase, { Feedback: FormControlFeedback });
const FormSelect = ({ className = '', children, onChange, ...p }: P & { onChange?: React.ChangeEventHandler<HTMLSelectElement> }) => (
  <select className={`${CTRL} ${className}`} onChange={onChange} {...p}>{children}</select>
);
const FormCheck = ({ type: _type, label, className = '', id, checked, onChange, disabled, ...p }: P & { type?: string; label?: ReactNode; checked?: boolean; onChange?: React.ChangeEventHandler<HTMLInputElement>; disabled?: boolean }) => (
  <label htmlFor={id} className={`inline-flex cursor-pointer items-center gap-2 text-sm text-ink ${className}`}>
    <input id={id} type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="h-4 w-4 rounded border-hairline accent-primary-500" {...p} />
    {label}
  </label>
);
const FormText = ({ className = '', children, ...p }: P) => (
  <small className={`mt-1 block text-xs text-ink-soft ${className}`} {...p}>{children}</small>
);
export const Form = Object.assign(FormBase, {
  Group: FormGroup, Label: FormLabel, Control: FormControl, Select: FormSelect, Check: FormCheck, Text: FormText,
});

// ---------------------------------------------------------------- InputGroup
// Flex row; neutralise inner control radii and re-round the ends so an
// addon + control read as one unit (approximates RB's border-radius handling).
const InputGroupBase = ({ className = '', children, size: _sz, ...p }: P & { size?: string }) => (
  <div
    className={`flex items-stretch [&>input]:rounded-none [&>select]:rounded-none [&>textarea]:rounded-none [&>*:first-child]:rounded-l [&>*:last-child]:rounded-r [&>input]:min-w-0 [&>input]:flex-1 ${className}`}
    {...p}
  >
    {children}
  </div>
);
const InputGroupText = ({ className = '', children, ...p }: P) => (
  <span className={`flex items-center border border-hairline bg-raised px-2.5 text-sm text-ink-soft ${className}`} {...p}>{children}</span>
);
export const InputGroup = Object.assign(InputGroupBase, { Text: InputGroupText });

// ---------------------------------------------------------------- ButtonGroup
export const ButtonGroup = ({ className = '', children, size: _sz, ...p }: P & { size?: string }) => (
  <div className={`inline-flex [&>button]:rounded-none [&>button]:-ml-px [&>*:first-child]:rounded-l [&>*:first-child]:ml-0 [&>*:last-child]:rounded-r ${className}`} {...p}>{children}</div>
);

// ---------------------------------------------------------------- ProgressBar
const progressTone: Record<string, string> = {
  success: 'bg-success-500', danger: 'bg-danger-500', warning: 'bg-warning-500',
  info: 'bg-accent-500', primary: 'bg-primary-500',
};
export const ProgressBar = ({ now = 0, max = 100, variant = 'primary', label, className = '', style }: P & { now?: number; max?: number; variant?: string; label?: ReactNode }) => {
  const pct = Math.max(0, Math.min(100, (now / (max || 100)) * 100));
  return (
    <div className={`h-2 w-full overflow-hidden rounded-full bg-raised ${className}`} style={style}>
      <div className={`flex h-full items-center justify-center rounded-full text-[0.65rem] text-white transition-all ${progressTone[variant] ?? progressTone.primary}`} style={{ width: `${pct}%` }}>
        {label}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- ListGroup
const ListGroupBase = ({ className = '', children, ...p }: P) => (
  <div className={`divide-y divide-hairline overflow-hidden rounded border border-hairline ${className}`} {...p}>{children}</div>
);
const ListGroupItem = ({ action, active, variant: _v, className = '', children, onClick, ...p }: P & { action?: boolean; active?: boolean; variant?: string }) => (
  <div
    onClick={onClick}
    className={`px-3 py-2 text-sm ${active ? 'bg-primary-500/15 text-ink' : 'text-ink'} ${action ? 'cursor-pointer hover:bg-raised' : ''} ${className}`}
    {...p}
  >
    {children}
  </div>
);
export const ListGroup = Object.assign(ListGroupBase, { Item: ListGroupItem });

// ---------------------------------------------------------------- Modal
const ModalCtx = createContext<{ onHide?: () => void }>({});
// Bootstrap parity: modal-lg was 800px, modal-xl 1140px — the big config
// modals (strategy definition / config tree) need the xl real estate.
const modalSizes: Record<string, string> = { sm: 'max-w-md', lg: 'max-w-3xl', xl: 'max-w-6xl' };
const ModalBase = ({ show, onHide, size, backdrop, className = '', children, ...p }: P & { show?: boolean; onHide?: () => void; size?: string; backdrop?: boolean | 'static' }) => {
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onHide?.();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [show, onHide]);
  if (!show) return null;
  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-[6vh]" onClick={() => backdrop !== 'static' && onHide?.()}>
      <div
        className={`relative w-full ${modalSizes[size ?? ''] ?? 'max-w-lg'} rounded-card border border-hairline bg-card shadow-card dark:shadow-card-dark ${className}`}
        onClick={(e) => e.stopPropagation()}
        {...p}
      >
        <ModalCtx.Provider value={{ onHide }}>{children}</ModalCtx.Provider>
      </div>
    </div>,
    document.body,
  );
};
const ModalHeader = ({ closeButton, className = '', children, ...p }: P & { closeButton?: boolean }) => {
  const { onHide } = useContext(ModalCtx);
  return (
    <div className={`flex items-center justify-between gap-4 border-b border-hairline p-3 ${className}`} {...p}>
      <div className="min-w-0">{children}</div>
      {closeButton && (
        <button type="button" onClick={() => onHide?.()} aria-label="Close" className="text-xl leading-none text-ink-faint hover:text-ink">
          ×
        </button>
      )}
    </div>
  );
};
const ModalTitle = ({ className = '', children, ...p }: P) => (
  <h5 className={`mb-0 truncate font-semibold text-ink ${className}`} {...p}>{children}</h5>
);
const ModalBody = ({ className = '', children, ...p }: P) => (
  <div className={`max-h-[70vh] overflow-y-auto p-4 ${className}`} {...p}>{children}</div>
);
const ModalFooter = ({ className = '', children, ...p }: P) => (
  <div className={`flex items-center justify-end gap-2 border-t border-hairline p-3 ${className}`} {...p}>{children}</div>
);
export const Modal = Object.assign(ModalBase, { Header: ModalHeader, Title: ModalTitle, Body: ModalBody, Footer: ModalFooter });

// ---------------------------------------------------------------- Dropdown
const DropdownCtx = createContext<{ open: boolean; setOpen: (o: boolean) => void }>({ open: false, setOpen: () => {} });
const DropdownBase = ({ className = '', children, ...p }: P) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div ref={ref} className={`relative inline-block ${className}`} {...p}>
      <DropdownCtx.Provider value={{ open, setOpen }}>{children}</DropdownCtx.Provider>
    </div>
  );
};
const DropdownToggle = ({ variant = 'secondary', size, className = '', children, ...p }: P & { variant?: string; size?: string }) => {
  const { open, setOpen } = useContext(DropdownCtx);
  return (
    <Button variant={variant} size={size} className={className} onClick={() => setOpen(!open)} {...p}>
      {children}
      <span className="ml-1 text-[0.6em]">▾</span>
    </Button>
  );
};
const DropdownMenu = ({ align, className = '', children, ...p }: P & { align?: string }) => {
  const { open } = useContext(DropdownCtx);
  if (!open) return null;
  return (
    <div
      className={`absolute z-[1050] mt-1 min-w-[10rem] overflow-hidden rounded-card border border-hairline bg-card py-1 shadow-card dark:shadow-card-dark ${align === 'end' ? 'right-0' : 'left-0'} ${className}`}
      {...p}
    >
      {children}
    </div>
  );
};
const DropdownItem = ({ className = '', children, onClick, disabled, ...p }: P & { onClick?: React.MouseEventHandler<HTMLButtonElement>; disabled?: boolean }) => {
  const { setOpen } = useContext(DropdownCtx);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e);
        setOpen(false);
      }}
      className={`block w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-raised disabled:opacity-50 ${className}`}
      {...p}
    >
      {children}
    </button>
  );
};
const DropdownDivider = ({ className = '' }: P) => <div className={`my-1 border-t border-hairline ${className}`} />;
const DropdownHeader = ({ className = '', children }: P) => <div className={`px-3 py-1 text-xs font-semibold uppercase text-ink-faint ${className}`}>{children}</div>;
export const Dropdown = Object.assign(DropdownBase, { Toggle: DropdownToggle, Menu: DropdownMenu, Item: DropdownItem, Divider: DropdownDivider, Header: DropdownHeader });

// ---------------------------------------------------------------- Tabs / Tab
// Only the ACTIVE tab's children are rendered (react-bootstrap keeps all
// mounted-but-hidden). Fine for independent tabs; if a page needs all tabs
// mounted at once, render them with a hidden toggle instead of using Tabs.
export interface TabProps {
  eventKey: string;
  title: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
}
const TabComponent: React.FC<TabProps> = () => null;

// Tab.Container / Tab.Content / Tab.Pane + Nav.Link share this context (RB's
// activeKey-driven pill/pane pattern).
const TabCtx = createContext<{ activeKey?: string; onSelect?: (k: string | null) => void }>({});
const TabContainer = ({ activeKey, onSelect, children }: P & { activeKey?: string; onSelect?: (k: string | null) => void }) => (
  <TabCtx.Provider value={{ activeKey, onSelect }}>{children}</TabCtx.Provider>
);
const TabContent = ({ className = '', children, ...p }: P) => <div className={className} {...p}>{children}</div>;
const TabPane = ({ eventKey, className = '', children, ...p }: P & { eventKey?: string }) => {
  const { activeKey } = useContext(TabCtx);
  return activeKey === eventKey ? <div className={className} {...p}>{children}</div> : null;
};
export const Tab = Object.assign(TabComponent, { Container: TabContainer, Content: TabContent, Pane: TabPane });

// ---------------------------------------------------------------- Nav (pills)
const NavBase = ({ variant: _v, activeKey, onSelect, className = '', children, ...p }: P & { variant?: string; activeKey?: string; onSelect?: (k: string | null) => void }) => {
  const content = (
    <div className={`flex flex-wrap gap-1 ${className}`} {...p}>{children}</div>
  );
  // RB's <Nav activeKey onSelect> drives Nav.Link directly (no Tab.Container).
  return activeKey !== undefined || onSelect ? <TabCtx.Provider value={{ activeKey, onSelect }}>{content}</TabCtx.Provider> : content;
};
const NavItem = ({ className = '', children, ...p }: P) => <div className={className} {...p}>{children}</div>;
const NavLink = ({ eventKey, className = '', children, disabled, ...p }: P & { eventKey?: string; disabled?: boolean }) => {
  const { activeKey, onSelect } = useContext(TabCtx);
  const active = activeKey === eventKey;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => eventKey && onSelect?.(eventKey)}
      className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${active ? 'bg-primary-500 text-white' : 'text-ink-soft hover:bg-raised hover:text-ink'} ${className}`}
      {...p}
    >
      {children}
    </button>
  );
};
export const Nav = Object.assign(NavBase, { Item: NavItem, Link: NavLink });

// ---------------------------------------------------------------- Container
export const Container = ({ fluid: _f, className = '', children, ...p }: P & { fluid?: boolean | string }) => (
  <div className={`mx-auto w-full ${className}`} {...p}>{children}</div>
);

// ---------------------------------------------------------------- Collapse
export const Collapse = ({ in: show, children }: P & { in?: boolean }) => (show ? <>{children}</> : null);

// ---------------------------------------------------------------- Overlay/Tooltip/Popover
// react-bootstrap Tooltip/Popover are content holders passed to OverlayTrigger's
// `overlay`; render children as-is and let OverlayTrigger place them via ui/Tooltip.
export const Tooltip = ({ id: _i, className = '', children, ...p }: P) => <span className={className} {...p}>{children}</span>;
const PopoverBase = ({ id: _i, className = '', children, ...p }: P) => <div className={className} {...p}>{children}</div>;
const PopoverHeader = ({ className = '', children, ...p }: P) => <div className={`mb-1 font-semibold ${className}`} {...p}>{children}</div>;
const PopoverBody = ({ className = '', children, ...p }: P) => <div className={className} {...p}>{children}</div>;
export const Popover = Object.assign(PopoverBase, { Header: PopoverHeader, Body: PopoverBody });
export const OverlayTrigger = ({ overlay, placement, children }: P & { overlay?: ReactNode; placement?: string }) => (
  <UITooltip label={overlay} placement={placement === 'top' ? 'top' : 'bottom'}>{children}</UITooltip>
);

// ---------------------------------------------------------------- ToggleButtonGroup / ToggleButton
const TBGCtx = createContext<{ value?: any; onChange?: (v: any) => void }>({});
export const ToggleButtonGroup = ({ type: _t, value, onChange, name: _n, size: _s, className = '', children }: P & { type?: string; value?: any; onChange?: (v: any) => void; name?: string; size?: string }) => (
  <div className={`inline-flex overflow-hidden rounded border border-hairline ${className}`}>
    <TBGCtx.Provider value={{ value, onChange }}>{children}</TBGCtx.Provider>
  </div>
);
export const ToggleButton = ({ value, id: _i, variant, size, type: _t, name: _n, checked: _c, className = '', children, onClick, onChange, ...p }: P & { value?: any; id?: string; variant?: string; size?: string; type?: string; name?: string; checked?: boolean; onClick?: React.MouseEventHandler<HTMLButtonElement>; onChange?: (e: any) => void }) => {
  const ctx = useContext(TBGCtx);
  // Highlight comes from an explicit `variant` (most call-sites: primary when
  // active, outline-primary otherwise) OR from ToggleButtonGroup value context.
  const grouped = ctx.value !== undefined;
  const resolvedVariant = grouped ? (ctx.value === value ? 'primary' : 'outline-primary') : variant ?? 'outline-primary';
  return (
    <Button
      variant={resolvedVariant}
      size={size}
      className={className}
      onClick={(e) => {
        onChange?.(e);
        onClick?.(e);
        ctx.onChange?.(value);
      }}
      {...p}
    >
      {children}
    </Button>
  );
};

const tabBtnCls = (active: boolean) =>
  `-mb-px flex items-center gap-1 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
    active ? 'border-primary-500 text-primary-500' : 'border-transparent text-ink-soft hover:text-ink'
  }`;

export const Tabs = ({ activeKey, defaultActiveKey, onSelect, className = '', children }: P & { activeKey?: string; defaultActiveKey?: string; onSelect?: (k: string | null) => void }) => {
  const tabs = React.Children.toArray(children).filter(Boolean) as ReactElement<TabProps>[];
  // Uncontrolled mode (RB's defaultActiveKey): track the selection internally.
  const [internalKey, setInternalKey] = useState(defaultActiveKey);
  const currentKey = activeKey !== undefined ? activeKey : internalKey;
  const select = (k: string) => {
    if (activeKey === undefined) setInternalKey(k);
    onSelect?.(k);
  };
  return (
    <div>
      <div className={`mb-3 flex flex-wrap gap-1 border-b border-hairline ${className}`}>
        {tabs.map((t) => {
          const { eventKey, title, disabled } = t.props;
          return (
            <button key={eventKey} type="button" disabled={disabled} onClick={() => select(eventKey)} className={tabBtnCls(eventKey === currentKey)}>
              {title}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (t.props.eventKey === currentKey ? <div key={t.props.eventKey}>{t.props.children}</div> : null))}
    </div>
  );
};
