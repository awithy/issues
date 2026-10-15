import { useRef, useState } from 'react';
import type { ApiClient } from '../../src/shared/client';
import type { Attachment } from '../../src/shared/types';
import { attachmentImageType } from '../../src/shared/attachments';
import { Modal } from './ui';

export function ImageAttachments({ api, attachments }: { api: ApiClient; attachments: Attachment[] }) {
  const images = attachments.filter(file => attachmentImageType(file));
  return images.length > 0 ? <section className="image-attachments" aria-label="Image attachments">
    <h3>Images <span className="count">{images.length}</span></h3>
    {images.map(file => <ImageAttachment key={file.attachmentId} api={api} file={file} />)}
  </section> : null;
}

function ImageAttachment({ api, file }: { api: ApiClient; file: Attachment }) {
  const [expanded, setExpanded] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const url = api.attachmentUrl(file.attachmentId, true);
  return <figure className="image-attachment card">
    <figcaption className="field-heading"><span>{file.filename}</span>
      <button ref={expandButton} type="button" className="secondary" aria-label={'Expand ' + file.filename} onClick={() => setExpanded(true)}>⤢ Expand</button>
    </figcaption>
    <img className="attachment-preview" src={url} alt={file.filename} loading="lazy" />
    {expanded && <Modal title={file.filename} className="image-modal" onClose={() => { setExpanded(false); expandButton.current?.focus(); }}>
      <p className="muted small">Full size. Scroll to see the entire image.</p>
      <div className="full-size-image"><img src={url} alt={file.filename} /></div>
    </Modal>}
  </figure>;
}
