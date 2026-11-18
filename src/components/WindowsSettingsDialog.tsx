// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, ExternalLink, FileCheck2, Keyboard, LoaderCircle, RefreshCw, Settings2, X } from 'lucide-react';
import { backend, errorMessage, isDesktop } from '../backend';
import { useI18n } from '../i18n';
import packageInfo from '../../package.json';

type IntegrationResult = { applicationName: string; progId: string; settingsUri: string; registered: boolean; settingsOpened: boolean; selectionRequired?: boolean };

export function WindowsSettingsDialog({ onClose, onShortcuts }: { onClose: () => void; onShortcuts: () => void }) {
  const { t } = useI18n();
  const modal = useRef<HTMLElement>(null), pending = useRef(false), alive = useRef(true);
  const [working, setWorking] = useState<'default' | 'repair' | null>(null);
  const [error, setError] = useState(''), [result, setResult] = useState<'default' | 'repair' | null>(null);
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement;
    modal.current?.focus();
    return () => { alive.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const run = async (action: 'default' | 'repair') => {
    if (pending.current || !isDesktop()) return;
    pending.current = true; setWorking(action); setError(''); setResult(null);
    try {
      const response = await backend<IntegrationResult>(action === 'default' ? 'open_default_pdf_settings' : 'register_pdf_integration');
      if (!response.registered) throw new Error(t('Windows 应用注册未完成，请重试。', 'Windows application registration did not complete. Try again.'));
      if (action === 'default' && !response.settingsOpened) throw new Error(t('未能打开 Windows 设置。请重试，或在系统设置中搜索默认应用。', 'Windows settings did not open. Try again, or search for default apps in system settings.'));
      if (alive.current) setResult(action);
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (alive.current) setWorking(null); }
  };
  return <div className="modal-backdrop settings-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !working) onClose(); }} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' && !working) { event.preventDefault(); onClose(); }
    if ((event.ctrlKey || event.metaKey) && ['o', 's', 'p', 'f'].includes(event.key.toLowerCase())) event.preventDefault();
    if (event.key === 'Tab') {
      const controls = [...(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])];
      if (!controls.length) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === modal.current)) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && (document.activeElement === controls.at(-1) || document.activeElement === modal.current)) { event.preventDefault(); controls[0].focus(); }
    }
  }}>
    <section ref={modal} tabIndex={-1} className="modal windows-settings-modal" role="dialog" aria-modal="true" aria-labelledby="windows-settings-title">
      <button className="icon-button modal-close" aria-label={t('关闭设置', 'Close settings')} onClick={onClose} disabled={!!working}><X size={18}/></button>
      <div className="modal-symbol"><Settings2 size={25}/></div>
      <h2 id="windows-settings-title">{t('应用设置', 'App settings')}</h2>
      <p className="modal-description">Jerrivell PDF {packageInfo.version} · {t('Windows 集成与常用操作', 'Windows integration and everyday shortcuts')}</p>
      <div className="settings-section">
        <h3><FileCheck2 size={18}/>{t('默认 PDF 应用', 'Default PDF app')}</h3>
        <p>{t('打开 Windows 默认应用设置，在 .pdf 的打开方式中选择 Jerrivell PDF。默认关联由 Windows 确认。', 'Open Windows default app settings and choose Jerrivell PDF for .pdf files. Windows confirms the association.')}</p>
        <p>{t('如果候选未显示，可在 PDF 的“打开方式 → 选择其他应用”中浏览已安装的 jerrivell-pdf.exe，再返回系统设置。', 'If the app is missing, browse to the installed jerrivell-pdf.exe through Open with → Choose another app, then return to system settings.')}</p>
        <button className="button primary settings-action" disabled={!!working || !isDesktop()} onClick={() => void run('default')}>{working === 'default' ? <LoaderCircle size={16} className="spin"/> : <ExternalLink size={16}/>} {t('设置为默认 PDF 应用', 'Set as default PDF app')}</button>
      </div>
      <div className="settings-section">
        <h3>{t('资源管理器打开方式', 'File Explorer Open with')}</h3>
        <p>{t('安装时注册“打开方式”、PDF 右键命令和“发送到”。如果移动了程序或入口缺失，可修复当前安装的注册。', 'Installation registers Open with, the PDF context command and Send to. Repair registration if you moved the app or an entry is missing.')}</p>
        <button className="button secondary settings-action" disabled={!!working || !isDesktop()} onClick={() => void run('repair')}>{working === 'repair' ? <LoaderCircle size={16} className="spin"/> : <RefreshCw size={16}/>} {t('修复打开方式入口', 'Repair Open with registration')}</button>
      </div>
      {result && <p className="settings-result" role="status"><Check size={16}/>{result === 'default' ? t('已打开 Windows 设置。请选择 .pdf 的默认应用；关闭设置后可继续编辑。', 'Windows settings opened. Choose the default app for .pdf, then return to editing.') : t('打开方式注册已更新。可重新打开右键菜单查看。', 'Open with registration was updated. Reopen the context menu to check it.')}</p>}
      {!isDesktop() && <p className="field-hint">{t('请在 Windows 桌面应用中使用这些设置。', 'Use these settings in the Windows desktop app.')}</p>}
      {error && <p className="form-error" role="alert"><CircleAlert size={15}/>{error}</p>}
      <div className="modal-actions"><button className="button secondary" disabled={!!working} onClick={onShortcuts}><Keyboard size={16}/>{t('键盘快捷键', 'Keyboard shortcuts')}</button><button className="button primary" disabled={!!working} onClick={onClose}>{t('完成', 'Done')}</button></div>
    </section>
  </div>;
}
