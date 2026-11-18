// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { backend, errorMessage } from '../backend';
import { useI18n } from '../i18n';
import { cssFontFamily } from './overlayCanvas';

interface SystemFonts { families: string[]; source: 'windows'; truncated: boolean }

export function FontPicker({ value, onChange, disabled = false, sample, embedForOriginal = false }: { value: string; onChange: (family: string) => void; disabled?: boolean; sample?: string; embedForOriginal?: boolean }) {
  const { t } = useI18n();
  const [families, setFamilies] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const request = useRef(0);
  const load = async () => {
    const id = ++request.current;
    setLoading(true); setError('');
    try {
      const result = await backend<SystemFonts>('list_system_fonts');
      if (id !== request.current) return;
      if (!Array.isArray(result.families)) throw new Error(t('无法读取本机字体列表。', 'The local font list could not be read.'));
      setFamilies(result.families); setTruncated(Boolean(result.truncated));
      if (result.families.length && !result.families.includes(value)) {
        const preferred = ['Microsoft YaHei UI', 'Microsoft YaHei', '微软雅黑', 'Segoe UI'].find(family => result.families.includes(family));
        onChange(preferred ?? result.families[0]);
      }
    } catch (failure) { if (id === request.current) setError(errorMessage(failure)); }
    finally { if (id === request.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { request.current++; }; }, []);
  const filtered = families.filter(family => family.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const options = filtered.includes(value) ? filtered : [value, ...filtered];
  return <div className="oe-font-picker">
    <div className="oe-font-heading"><span>{t('本机字体', 'Installed font')}</span><button type="button" className="oe-small-button" disabled={disabled || loading} onClick={() => void load()} title={t('刷新本机字体', 'Refresh installed fonts')}><RefreshCw size={11}/>{t('刷新', 'Refresh')}</button></div>
    <label className="oe-field"><input aria-label={t('搜索本机字体', 'Search installed fonts')} type="search" placeholder={t('搜索字体名称…', 'Search font names…')} value={query} disabled={disabled || loading} onChange={event => setQuery(event.target.value)}/></label>
    <label className="oe-field"><select aria-label={t('选择本机字体', 'Choose an installed font')} value={value} disabled={disabled || loading} style={{ fontFamily: cssFontFamily(value) }} onChange={event => onChange(event.target.value)}>{options.map(family => <option key={family} value={family}>{family}</option>)}</select></label>
    <div className="oe-font-preview" style={{ fontFamily: cssFontFamily(value) }} aria-label={t('所选字体预览', 'Selected font preview')}>{sample?.trim().slice(0, 100) || t('字体预览 AaBb 123 中文', 'Font preview AaBb 123 中文')}</div>
    <p className="oe-note" role="status">{loading ? t('正在读取 Windows 字体…', 'Reading Windows fonts…') : error ? t('字体列表读取失败，可刷新重试。', 'Could not read installed fonts. Refresh to retry.') + ' ' + error : t(`已识别 ${families.length} 种字体；筛选 ${filtered.length} 种。`, `${families.length} installed families; ${filtered.length} matches.`)}{truncated && ' ' + t('字体列表已按数量或读取预算截断，可刷新重试。', 'The font list was limited by count or reading budget. Refresh to retry.')}</p>
    <p className="oe-note">{embedForOriginal
      ? t('原文替换需要把字体嵌入保存的 PDF。应用时会检查嵌入权限与缺字；请确认字体许可允许此用途。', 'Original text replacement embeds the font in the saved PDF. Applying changes checks embedding flags and required glyphs; confirm that the font license permits this use.')
      : t('仅使用本机字体，不复制字体文件。字体缺少的字形可能由系统回退显示。', 'Uses local fonts without copying font files. Missing glyphs may use system fallback fonts.')}</p>
  </div>;
}
