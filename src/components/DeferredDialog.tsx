// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { useI18n } from '../i18n';

/** Paint a lightweight, cancellable shell before mounting a large dialog tree. */
export function DeferredDialog({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const shell = useRef<HTMLElement>(null);
  useEffect(() => {
    shell.current?.focus();
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setReady(true)); });
    return () => { cancelAnimationFrame(first); if (second) cancelAnimationFrame(second); };
  }, []);
  if (ready) return children;
  return <div className="modal-backdrop deferred-dialog-backdrop" onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); onCancel(); } else if (event.ctrlKey || event.metaKey) event.preventDefault(); }}>
    <section ref={shell} className="modal deferred-dialog-shell" tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('正在准备预览', 'Preparing preview')}>
      <LoaderCircle className="spin" size={22}/><p role="status">{t('正在准备预览…', 'Preparing preview…')}</p>
      <button className="icon-button modal-close" aria-label={t('取消', 'Cancel')} onClick={onCancel}><X size={18}/></button>
    </section>
  </div>;
}
