import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function ErrorNotice({ error }: { error: string }) { return error ? <div className="error" role="alert">{error}</div> : null; }
export function Modal({ title, children, onClose, className, busy = false }: { title: string; children: ReactNode; onClose: () => void; className?: string; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!; dialog.showModal();
    return () => dialog.close();
  }, []);
  function close() { if (busy) return; ref.current?.close(); onClose(); }
  return <dialog ref={ref} className={className} aria-label={title} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="modal-heading"><h2>{title}</h2><button type="button" className="ghost" aria-label="Close dialog" disabled={busy} onClick={close}>✕</button></div>
    {children}
  </dialog>;
}
export function MarkdownField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [preview, setPreview] = useState(false);
  return <div className="markdown-field">
    <div className="field-heading"><label htmlFor={label}>{label}</label><div className="tabs">
      <button type="button" className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>Write<span className="sr-only"> {label}</span></button>
      <button type="button" className={preview ? 'active' : ''} onClick={() => setPreview(true)}>Preview<span className="sr-only"> {label}</span></button>
    </div></div>
    {preview ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{value || '*Nothing here yet.*'}</ReactMarkdown></div>
      : <textarea id={label} value={value} onChange={event => onChange(event.target.value)} rows={8} placeholder={label + ' supports Markdown…'} />}
  </div>;
}
