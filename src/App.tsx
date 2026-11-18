import { PageTextLayer } from './components/PageTextLayer';
import { TextToolLayer } from './components/TextToolLayer';
import { finishInlineTextEvent } from './components/InlineTextInput';
import type { TextOverlaySource } from './components/overlayCanvas';
import { ExportDialog } from './components/ExportDialog';
import { PageToolsDialog } from './components/PageToolsDialog';
import { TextLineEditor } from './components/TextLineEditor';
import { duplicatePage } from './documentTools';
import type { ExportPart, ExportResult } from './documentTools';
import { PdfViewer } from './components/PdfViewer';
import type { PageNavigation } from './components/PdfViewer';
import { PageThumbnails } from './components/PageThumbnails';
import { MarkToolbar } from './components/MarkToolbar';
import { MarkLayer } from './components/MarkLayer';
import { createMarkGeometry, DEFAULT_MARK } from './markGeometry';
import { EditableMarkHandles } from './components/EditableMarkHandles';
import { attachLeader, prepareEditableOverlays } from './editableOverlays';
import type { OverlayChangeOptions } from './editableOverlays';
import { DEFAULT_FONT_FAMILY } from './components/overlayCanvas';
import type { MarkGeometry, MarkSettings, MarkStylePatch } from './markGeometry';
import { clampZoom, fittedPageWidth, reorderPages, visiblePageSize } from './viewerGeometry';
import type { ViewerZoom, ViewportSize } from './viewerGeometry';
import { duplicatedOverlay } from './overlayGeometry';
import brandIcon from './brand/jerrivell-icon.svg';
import { I18nProvider, useI18n, translate as t } from './i18n';
import { PageRangeError, parsePageRange } from './pageRanges';
import { rotatePageClockwise } from './pageOperations';
import { ImageEditDialog } from './components/ImageEditDialog';
import { WindowsSettingsDialog } from './components/WindowsSettingsDialog';
import { DeferredDialog } from './components/DeferredDialog';
import { OverlayEditor } from './components/OverlayEditor';
import { OverlayHandles } from './components/OverlayHandles';
import { PrintDialog } from './components/PrintDialog';
import { OriginalContentEditor } from './components/OriginalContentEditor';
import { OriginalContentHandles } from './components/OriginalContentHandles';
import type { ContentEdit, ContentInspection } from './originalContent';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ArrowDown, ArrowUp, Check, CheckCheck, ChevronLeft, ChevronRight, CircleAlert, Copy, FilePlus2, FileText, FolderOpen, GripVertical, Highlighter, ImageDown, Keyboard, Layers3, LoaderCircle, Maximize2, Minus, PanelLeftClose, PanelLeftOpen, PenLine, Plus, Printer, Redo2, RotateCw, Save, Search, Settings2, ShieldCheck, Trash2, Undo2, Upload, Wrench, X, } from 'lucide-react';
import { backend, cancelledRequest, errorMessage, hydrateImageAssets, isDesktop, pageReference, resetBackendQueue, sessionInvalidatedEvent, stageImageAsset } from './backend';
import { validateEditableWorkspace, validateLoadedProject } from './editableProject';
import type { ImageAsset, BackendStatus, DocumentInfo, PageOverlay, SearchMatch, WorkspaceMatch, WorkspacePage } from './types';
type Panel = 'pages' | 'search';
type ExportRequest = { parts: ExportPart[]; saveWorkspace: boolean; resolve: (value: boolean) => void };
type ImportRequest = { paths: string[]; range: string; position: 'after' | 'end' | 'before'; targetPage: string };
type ImportOptions = { range?: string; insertAt?: number };
type Toast = {
    id: number;
    message: string;
    tone: 'success' | 'error' | 'info';
};
type History = {
    entries: WorkspacePage[][];
    cursor: number;
};
type PasswordRequest = {
    path: string;
    resolve: (value: string | null) => void;
};
const pdfFilters = () => [{ name: t('PDF 文档'), extensions: ['pdf'] }];
const signature = (pages: WorkspacePage[]) => JSON.stringify(pages);
function rangeErrorMessage(error: unknown, pageCount: number): string {
    const code = error instanceof PageRangeError ? error.code : 'FORMAT';
    if (code === 'EMPTY') return t('请输入页码范围，例如 1-3,5。', 'Enter a page range, such as 1-3,5.');
    if (code === 'BOUNDS') return t(`页码必须在 1～${pageCount} 之间。`, `Page numbers must be between 1 and ${pageCount}.`);
    if (code === 'ORDER') return t('范围起始页不能大于结束页。', 'A range must start before it ends.');
    if (code === 'TOO_LONG') return t('页码范围过长，请分次操作。', 'The page range is too long. Use smaller groups.');
    return t('页码格式无效，请用逗号分隔页码或范围，例如 1-3,5。', 'Invalid page range. Separate pages and ranges with commas, such as 1-3,5.');
}
const normalizePath = (path: string) => {
    let result = path.replace(/\\/g, '/');
    if (result.toLowerCase().startsWith('//?/unc/')) result = '//' + result.slice(8);
    else if (result.startsWith('//?/')) result = result.slice(4);
    return result.toLowerCase();
};
const nextId = () => crypto.randomUUID();
const sizeLabel = (bytes: number) => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const pdfName = (name: string) => name.replace(/\.pdf$/i, '');
function PasswordDialog({ request, onAnswer }: {
    request: PasswordRequest;
    onAnswer: (value: string | null) => void;
}) {
    const [value, setValue] = useState('');
    return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget)
        onAnswer(null); }}>
    <form className="modal password-modal" role="dialog" aria-modal="true" aria-labelledby="password-title" onSubmit={(event) => { event.preventDefault(); onAnswer(value); }}>
      <button className="icon-button modal-close" type="button" aria-label={t("取消打开")} onClick={() => onAnswer(null)}><X size={18}/></button>
      <div className="modal-symbol"><ShieldCheck size={25}/></div>
      <h2 id="password-title">{t("这份文档已加密")}</h2><p className="modal-description">{t(`输入打开密码，继续处理 ${request.path.split(/[\\/]/).pop()}。`, `Enter the opening password to continue with ${request.path.split(/[\\/]/).pop()}.`)}</p>
      <label className="field-label" htmlFor="document-password">{t("文档密码")}</label><input id="document-password" className="text-input" type="password" autoFocus autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape')
        onAnswer(null); }}/>
      <div className="modal-actions"><button className="button secondary" type="button" onClick={() => onAnswer(null)}>{t("取消")}</button><button className="button primary" type="submit">{t("打开文档")}<ChevronRight size={15}/></button></div>
    </form>
  </div>;
}
function AppWorkspace() {
    const { language, setLanguage } = useI18n();
    const [status, setStatus] = useState<BackendStatus | null>(null);
    const [checkingEngine, setCheckingEngine] = useState(true);
    const [sources, setSources] = useState<DocumentInfo[]>([]);
    const [history, setHistory] = useState<History>({ entries: [[]], cursor: 0 });
    const pages = history.entries[history.cursor];
    const [activeId, setActiveId] = useState('');
    const activeIndex = Math.max(0, pages.findIndex((page) => page.id === activeId));
    const currentPage = pages[activeIndex];
    const [selection, setSelection] = useState<Set<string>>(new Set());
    const [panel, setPanel] = useState<Panel>('pages');
    const [editorOpen, setEditorOpen] = useState(false);
    const [selectText, setSelectText] = useState(true);
    const [textDrawMode, setTextDrawMode] = useState(false);
    const [inlineEditing, setInlineEditing] = useState(false);
    const [textToolStyle, setTextToolStyle] = useState<TextOverlaySource>({content:'',fontSize:24,color:'#242b3e',bold:false,fontFamily:DEFAULT_FONT_FAMILY,padding:0,lineHeight:1.45});
    const [originalOpen, setOriginalOpen] = useState(false);
    const [originalSelected, setOriginalSelected] = useState('');
    const [originalEraseMode,setOriginalEraseMode] = useState(false);
    const [pixelEdit,setPixelEdit] = useState<{page:WorkspacePage;image:ImageAsset;overlayId?:string}|null>(null);
    const [originalInspection, setOriginalInspection] = useState<{ key: string; data: ContentInspection } | null>(null);
    const originalInspectionRef = useRef<{ key: string; data: ContentInspection } | null>(null);
    const [originalLoading, setOriginalLoading] = useState(false);
    const [originalError, setOriginalError] = useState('');
    const [originalRefresh, setOriginalRefresh] = useState(0);
    const originalBusyRef = useRef(false);
    const contentApplyRef = useRef(false);
    const [activeOverlayId, setActiveOverlayId] = useState('');
    const [pageToolsOpen, setPageToolsOpen] = useState(false);
    const [lineOpen, setLineOpen] = useState(false);
    const [exportRequest, setExportRequest] = useState<ExportRequest | null>(null);
    const exportRequestRef = useRef<ExportRequest | null>(null);
    exportRequestRef.current = exportRequest;
    const exportOpenRef = useRef(false);
    const workspaceModalRef = useRef(false);
    workspaceModalRef.current = pageToolsOpen || lineOpen || Boolean(exportRequest);
    const [printOpen, setPrintOpen] = useState(false);
    const printOpenRef = useRef(false);
    printOpenRef.current = printOpen;
    const [rangeInput, setRangeInput] = useState('');
    const [importRequest, setImportRequest] = useState<ImportRequest | null>(null);
    const [importError, setImportError] = useState('');
    const sourceRegistry = useRef(new Map<string, DocumentInfo>());
    const [busy, setBusy] = useState('');
    const [title, setTitle] = useState('');
    const [savedSignature, setSavedSignature] = useState('');
    const [savedPath, setSavedPath] = useState('');
    const [projectPath, setProjectPath] = useState('');
    const [zoom, setZoom] = useState<ViewerZoom>('fit');
    const [viewerSize, setViewerSize] = useState<ViewportSize>({ width: 900, height: 600 });
    const [navigation, setNavigation] = useState<PageNavigation | null>(null);
    const navigationSequence = useRef(0);
    const navigateToId = useCallback((id: string) => {
        setActiveId(id);
        setNavigation({ id, sequence: ++navigationSequence.current });
    }, []);
    const [markOpen, setMarkOpen] = useState(false);
    const [markSettings, setMarkSettings] = useState<MarkSettings>(DEFAULT_MARK);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [pageInput, setPageInput] = useState('1');
    const [query, setQuery] = useState('');
    const [searching, setSearching] = useState(false);
    const [searchResults, setSearchResults] = useState<WorkspaceMatch[]>([]);
    const [searchError, setSearchError] = useState('');
    const [searchedQuery, setSearchedQuery] = useState('');
    const [draggingFile, setDraggingFile] = useState(false);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [showShortcuts, setShowShortcuts] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const appRoot = useRef<HTMLDivElement>(null), appHeader = useRef<HTMLElement>(null), workspaceBody = useRef<HTMLDivElement>(null);
    const [replaceRequest, setReplaceRequest] = useState<string[] | null>(null);
    const [closeRequest, setCloseRequest] = useState<'document' | 'application' | null>(null);
    const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null);
    const searchField = useRef<HTMLInputElement>(null);
    const busyRef = useRef(false);
    const inlineEditingRef = useRef(false);
    const editorBusyRef = useRef(false);
    const closingRef = useRef(false);
    const live = useRef({ pages, sources, dirty: false });
    const workspaceSignature = useMemo(() => signature(pages), [pages]);
    const dirty = pages.length > 0 && workspaceSignature !== savedSignature;
    live.current = { pages, sources, dirty };
    const totalBytes = sources.reduce((sum, source) => sum + source.fileSize, 0);
    const hasPages = pages.length > 0;
    useLayoutEffect(() => {
        const measure = () => {
            if (workspaceBody.current && appRoot.current) appRoot.current.style.setProperty('--workspace-panel-top', `${Math.round(workspaceBody.current.getBoundingClientRect().top)}px`);
        };
        measure();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        if (appHeader.current) observer?.observe(appHeader.current);
        window.addEventListener('resize', measure, { passive: true });
        return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
    }, [hasPages]);
    const warnings = sources.flatMap((source) => source.warnings.map((message) => ({ source: source.fileName, message })));
    const [showWarnings, setShowWarnings] = useState(false);
    const resetWorkspace = useCallback(() => {
        inlineEditingRef.current = false; setInlineEditing(false); setTextDrawMode(false);
        resetBackendQueue();
        setHistory({ entries: [[]], cursor: 0 });
        sourceRegistry.current.clear();
        setRangeInput('');
        setImportRequest(null);
        setImportError('');
        setEditorOpen(false); setTextDrawMode(false);
        setOriginalOpen(false);
        setMarkOpen(false);
        setPageToolsOpen(false);
        setLineOpen(false);
        exportRequestRef.current?.resolve(false);
        setExportRequest(null);
        exportOpenRef.current = false;
        setOriginalSelected('');
        setOriginalInspection(null);
        originalInspectionRef.current = null;
        setOriginalError('');
        setActiveOverlayId('');
        setPrintOpen(false);
        setPixelEdit(null);
        setOriginalEraseMode(false);
        setCloseRequest(null);
        setSources([]);
        setTitle('');
        setSavedPath('');
        setProjectPath('');
        setSavedSignature('');
        navigateToId('');
        setSelection(new Set());
        setQuery('');
        setSearchResults([]);
        setSearchError('');
        setSearchedQuery('');
        setSearching(false);
        setShowWarnings(false);
        setDraggingFile(false);
        live.current = { pages: [], sources: [], dirty: false };
    }, []);
    const notify = useCallback((message: string, tone: Toast['tone'] = 'info') => {
        const id = Date.now() + Math.random();
        setToasts((items) => [...items.slice(-2), { id, message, tone }]);
        window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), tone === 'error' ? 9000 : 4500);
    }, []);
    const checkEngine = useCallback(async () => {
        setCheckingEngine(true);
        if (!isDesktop()) {
            setStatus({ engineReady: false, message: t("请在 Jerrivell PDF 桌面应用中打开文档\u3002") });
            setCheckingEngine(false);
            return;
        }
        try {
            setStatus(await backend<BackendStatus>('get_backend_status'));
        }
        catch (error) {
            if (errorMessage(error) !== cancelledRequest)
                setStatus({ engineReady: false, message: errorMessage(error) });
        }
        finally {
            setCheckingEngine(false);
        }
    }, []);
    useEffect(() => { void checkEngine(); }, [checkEngine]);
    useEffect(() => {
        const invalidateSession = () => {
            resetWorkspace();
            notify(t("PDF 工作进程已重启\uFF0C当前工作区已清空\u3002未保存的页面调整需要重新操作\uFF1B请重新打开 PDF\u3002"), 'error');
            void backend('close_all_documents', undefined, 3).then(checkEngine).catch(() => { });
        };
        window.addEventListener(sessionInvalidatedEvent, invalidateSession);
        return () => window.removeEventListener(sessionInvalidatedEvent, invalidateSession);
    }, [checkEngine, notify, resetWorkspace]);
    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if ((live.current.dirty || inlineEditingRef.current) && !closingRef.current) {
                event.preventDefault();
                event.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', beforeUnload);
        if (!isDesktop())
            return () => window.removeEventListener('beforeunload', beforeUnload);
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void getCurrentWebviewWindow().onCloseRequested((event) => {
            if (closingRef.current)
                return;
            if (inlineEditingRef.current) {
                event.preventDefault(); notify(t('请先按 Ctrl+Enter 完成文字编辑，或按 Esc 取消，再关闭窗口。', 'Finish text editing with Ctrl+Enter, or cancel with Esc, before closing the window.')); return;
            }
            if (busyRef.current) {
                event.preventDefault();
                notify(t("正在处理文档\uFF0C请等待操作完成后退出\u3002"));
            }
            else if (printOpenRef.current) {
                event.preventDefault();
                setPrintOpen(false);
            }
            else if (live.current.dirty) {
                event.preventDefault();
                setCloseRequest('application');
            }
        }).then((cleanup) => { if (disposed)
            cleanup();
        else
            unlisten = cleanup; })
            .catch((error) => notify(t(`退出保护未能启用：${errorMessage(error)}`), 'error'));
        return () => { disposed = true; unlisten?.(); window.removeEventListener('beforeunload', beforeUnload); };
    }, [notify]);
    const closeApplication = async () => {
        closingRef.current = true;
        try {
            await getCurrentWebviewWindow().destroy();
        }
        catch (error) {
            closingRef.current = false;
            notify(t(`未能退出应用：${errorMessage(error)}`), 'error');
        }
    };
    useEffect(() => { setPageInput(String(activeIndex + 1)); }, [activeIndex]);
    useEffect(() => { setOriginalSelected(''); }, [activeId]);
    const pageOrderKey = useMemo(() => JSON.stringify(pages.map(page => page.id)), [pages]);
    useEffect(() => {
        if (!pages.some((page) => page.id === activeId) && pages.length)
            navigateToId(pages[Math.min(activeIndex, pages.length - 1)].id);
        setSelection((existing) => {
            const ids = new Set(pages.map(page => page.id));
            return [...existing].every(id => ids.has(id)) ? existing : new Set([...existing].filter(id => ids.has(id)));
        });
    }, [pageOrderKey]);
    const commit = useCallback((next: WorkspacePage[]) => {
        setHistory((previous) => {
            const entries = [...previous.entries.slice(0, previous.cursor + 1), next].slice(-60);
            return { entries, cursor: entries.length - 1 };
        });
    }, []);
    const updatePageOverlays = useCallback((pageId: string, overlays: PageOverlay[], options?: OverlayChangeOptions) => {
        const snapshot = live.current.pages;
        const target = snapshot.find(page => page.id === pageId);
        if (!target) return false;
        if (JSON.stringify(target.overlays ?? []) === JSON.stringify(overlays)) return true;
        try {
            const dimensions = visiblePageSize(target);
            const prepared = prepareEditableOverlays(target.overlays ?? [], overlays, dimensions.width, dimensions.height, options);
            if (prepared.images.some(image => image.dataUrl.length > 1_500_000)) throw new Error(t('添加内容图像超过单次保存限制，请减少文字或缩小内容区域。', 'The added content image exceeds the save limit. Reduce the text or content area.'));
            const staged = prepared.images.map(image => ({ overlayId: image.id, ...stageImageAsset(image.dataUrl) }));
            const imageIds = new Map(staged.map(image => [image.overlayId, image.id]));
            const stagedIds = new Set(staged.map(image => image.id));
            const editedIds = new Set(staged.map(image => image.overlayId));
            const next = prepared.overlays.map(item => imageIds.has(item.id) ? { ...item, assetId: imageIds.get(item.id)! } : item);
            commit(snapshot.map(page => page.id === target.id ? { ...page, overlays: next } : page));
            for (const image of staged) void image.registered.catch(error => {
                if (errorMessage(error) === cancelledRequest) return;
                const original = new Map((target.overlays ?? []).map(item => [item.id, item]));
                setHistory(history => ({ ...history, entries: history.entries.map(entry => entry.map(page => {
                    if (!page.overlays?.some(item => stagedIds.has(item.assetId))) return page;
                    // A text frame and its reattached leader form one transaction.
                    // Roll back both, including copied pages that share staged IDs.
                    const restored = page.overlays.flatMap(item => {
                        if (page.id === pageId && editedIds.has(item.id)) {
                            const before = original.get(item.id);
                            return before && !stagedIds.has(before.assetId) ? [before] : [];
                        }
                        return stagedIds.has(item.assetId) ? [] : [item];
                    });
                    const parents = new Set(restored.filter(item => item.textSource).map(item => item.id));
                    return { ...page, overlays: restored.filter(item => !item.leaderFor || parents.has(item.leaderFor)) };
                })) }));
                notify(t(`内容未能保存，已撤回受影响的修改：${errorMessage(error)}`, `Content could not be stored; the affected change was rolled back: ${errorMessage(error)}`), 'error');
            });
            return true;
        } catch (error) {
            const code = errorMessage(error);
            notify(code.includes('TEXT_FRAME_OVERFLOW') ? t('文字框空间不足。请扩大文字框或启用自动高度；原文字已保留。', 'The text does not fit. Enlarge the frame or enable auto height; the original text is retained.')
                : code.includes('OVERLAY_LIMIT') ? t('当前页面最多添加 30 个内容对象。文字引线占用两个对象。', 'A page can contain 30 added objects. A text callout uses two objects.')
                : code.includes('TEXT_PAGE_OVERFLOW') ? t('文字框超出了页面。请缩短内容或调整位置、宽度。', 'The text frame extends beyond the page. Shorten the text or adjust its position or width.') : code, 'error');
            return false;
        }
    }, [commit, notify]);
    const updateOverlays = useCallback((overlays: PageOverlay[]) => {
        if (currentPage) return updatePageOverlays(currentPage.id, overlays);
        return false;
    }, [currentPage?.id, updatePageOverlays]);
    const editorBusyChanged = useCallback((working: boolean) => {
        if (working) {
            editorBusyRef.current = true;
            busyRef.current = true;
            setBusy(t('正在处理添加内容…', 'Preparing added content…'));
        } else if (editorBusyRef.current) {
            editorBusyRef.current = false;
            busyRef.current = false;
            setBusy('');
        }
    }, []);
    const originalBusyChanged = useCallback((working: boolean) => {
        originalBusyRef.current = working;
        busyRef.current = working;
        setBusy(working ? t('正在校验原文修改…', 'Validating original content edits…') : '');
    }, []);
    const updateContentEdits = useCallback(async (contentEdits: ContentEdit[]): Promise<boolean> => {
        if (contentApplyRef.current || (busyRef.current && !originalBusyRef.current)) return false;
        const target = live.current.pages.find(page => page.id === currentPage?.id);
        if (!target) return false;
        if (JSON.stringify(target.contentEdits ?? []) === JSON.stringify(contentEdits)) return true;
        const ownedBusy = !originalBusyRef.current;
        contentApplyRef.current = true;
        if (ownedBusy) originalBusyChanged(true);
        try {
            const candidate: WorkspacePage = { ...target, contentEdits };
            const data = await backend<ContentInspection>('inspect_page_content', { page: pageReference(candidate) }, 3);
            if (!live.current.pages.some(page => page.id === target.id && page.documentId === target.documentId)) return false;
            const inspection = { key: `${candidate.id}:${JSON.stringify(pageReference(candidate))}`, data };
            originalInspectionRef.current = inspection;
            setOriginalInspection(inspection);
            setOriginalError('');
            commit(live.current.pages.map(page => page.id === target.id ? candidate : page));
            return true;
        } catch (error) { notify(errorMessage(error), 'error'); return false; }
        finally { contentApplyRef.current = false; if (ownedBusy) originalBusyChanged(false); }
    }, [currentPage?.id, commit, notify, originalBusyChanged]);
    const openPrint = useCallback(() => {
        if (!busyRef.current && pages.length) { setEditorOpen(false); setTextDrawMode(false); setOriginalOpen(false); setMarkOpen(false); setPrintOpen(true); }
    }, [pages.length]);
    const printingBusyChanged = useCallback((working: boolean) => {
        busyRef.current = working;
        setBusy(working ? t('正在准备或提交打印…', 'Preparing or submitting print job…') : '');
    }, []);
    const askPassword = useCallback((path: string) => new Promise<string | null>((resolve) => setPasswordRequest({ path, resolve })), []);
    const answerPassword = (value: string | null) => { passwordRequest?.resolve(value); setPasswordRequest(null); };
    const saveProject = useCallback(async (): Promise<boolean> => {
        if (inlineEditingRef.current) { notify(t('请先完成或取消当前文字编辑。', 'Finish or cancel the current text edit first.')); return false; }
        if (busyRef.current || !live.current.pages.length) return false;
        busyRef.current = true; setBusy(t('正在保存可编辑项目…', 'Saving editable project…'));
        try {
            const path = await save({ title: t('保存可编辑项目', 'Save editable project'), defaultPath: projectPath || `${title.replace(/\.[^.]+$/, '') || 'Jerrivell'}.jvp`, filters: [{ name: 'Jerrivell Project', extensions: ['jvp'] }] });
            if (!path) return false;
            const snapshot = live.current.pages;
            validateEditableWorkspace(snapshot);
            await backend('save_editable_project', { path, pages: snapshot, title: title || 'Jerrivell' }, 3);
            setProjectPath(path); setSavedSignature(signature(snapshot));
            notify(t('已保存可编辑项目，文字、折点与源 PDF 均已保留。', 'Editable project saved with text, path nodes and source PDFs.'), 'success');
            return true;
        } catch (error) { notify(errorMessage(error), 'error'); return false; }
        finally { busyRef.current = false; setBusy(''); }
    }, [projectPath, title, notify]);
    const loadPaths = useCallback(async (paths: string[], append: boolean, options: ImportOptions = {}) => {
        if (inlineEditingRef.current) { notify(t('请先完成或取消当前文字编辑。', 'Finish or cancel the current text edit first.')); return; }
        if (busyRef.current || printOpenRef.current || workspaceModalRef.current)
            return;
        if (paths.some(path => /\.jvp$/i.test(path)) && paths.length !== 1) {
            notify(t('可编辑项目需要单独打开，请只选择一个 .jvp 文件。', 'Open an editable project separately. Select only one .jvp file.'), 'error'); return;
        }
        if (paths.length === 1 && /\.jvp$/i.test(paths[0])) {
            if (append) { notify(t('可编辑项目请单独打开；合并页面请导入 PDF。', 'Open editable projects separately; import a PDF to merge pages.'), 'error'); return; }
            busyRef.current = true; setBusy(t('正在打开可编辑项目…', 'Opening editable project…'));
            try {
                // The worker validates every document and asset before replacing its session.
                const loaded = validateLoadedProject(await backend('load_editable_project', { path: paths[0] }, 3));
                resetWorkspace(); hydrateImageAssets(loaded.assets);
                for (const document of loaded.documents) sourceRegistry.current.set(normalizePath(document.path), document);
                setSources(loaded.documents); setHistory({ entries: [loaded.workspace], cursor: 0 });
                setTitle(loaded.title); setProjectPath(paths[0]); setSavedSignature(signature(loaded.workspace));
                live.current = { pages: loaded.workspace, sources: loaded.documents, dirty: false };
                if (loaded.workspace[0]) navigateToId(loaded.workspace[0].id);
                notify(t('项目已恢复。字体使用本机字体；导出 PDF 请使用“保存副本”。', 'Project restored. Text uses local fonts; use Save copy to export a PDF.'), 'success');
            } catch (error) { notify(errorMessage(error), 'error'); }
            finally { busyRef.current = false; setBusy(''); }
            return;
        }
        const pdfs = paths.filter((path) => /\.pdf$/i.test(path));
        if (!pdfs.length) {
            notify(t("请选择 PDF 格式的文档\u3002"), 'error');
            return;
        }
        busyRef.current = true;
        setBusy(append ? t("正在添加文档\u2026") : t("正在打开文档\u2026"));
        try {
            if (!append) {
                // The user has already confirmed replacement. Release the previous worker
                // before opening a new workspace so its source quota and snapshots reset.
                resetWorkspace();
                await backend('close_all_documents', undefined, 3);
            }
            const added: DocumentInfo[] = [];
            const newPages: WorkspacePage[] = [];
            for (let i = 0; i < pdfs.length; i++) {
                setBusy(t(`正在打开文档 ${i + 1} / ${pdfs.length}…`));
                let document: DocumentInfo | undefined = sourceRegistry.current.get(normalizePath(pdfs[i]));
                let password: string | undefined;
                try {
                    while (!document) {
                        try {
                            document = await backend<DocumentInfo>('open_document', { path: pdfs[i], password });
                        }
                        catch (error) {
                            if (!errorMessage(error).includes('PASSWORD_REQUIRED:'))
                                throw error;
                            if (password !== undefined)
                                notify(t("密码不正确\uFF0C请重试或取消此文件\u3002"), 'error');
                            const answer = await askPassword(pdfs[i]);
                            if (answer === null)
                                break;
                            password = answer;
                        }
                    }
                }
                catch (error) {
                    const message = errorMessage(error);
                    if (message.includes('SESSION_INVALIDATED:') || message === cancelledRequest)
                        throw error;
                    notify(`${pdfs[i].split(/[\\/]/).pop()}：${message}`, 'error');
                    continue;
                }
                if (!document)
                    continue;
                sourceRegistry.current.set(normalizePath(pdfs[i]), document);
                sourceRegistry.current.set(normalizePath(document.path), document);
                if (!document.pages.length) {
                    notify(t(`${document.fileName} 没有可显示的页面。`), 'error');
                    continue;
                }
                let indices: number[];
                try { indices = parsePageRange(options.range ?? '', document.pageCount, true); }
                catch (error) { notify(t(`来源 ${document.fileName}：${rangeErrorMessage(error, document.pageCount)}`, `Source ${document.fileName}: ${rangeErrorMessage(error, document.pageCount)}`), 'error'); continue; }
                added.push(document);
                newPages.push(...indices.map((index) => { const page = document!.pages[index]; return { id: nextId(), documentId: document!.id, pageIndex: page.index, rotation: 0, overlays: [], width: page.width, height: page.height, sourceName: document!.fileName }; }));
            }
            if (!newPages.length)
                return;
            if (newPages.length + (append ? live.current.pages.length : 0) > 5000) { notify(t('合并后不能超过5000页，请减少导入范围。', 'The merged document cannot exceed 5000 pages. Import a smaller range.'), 'error'); return; }
            if (append && live.current.pages.length) {
                const insertAt = Math.max(0, Math.min(options.insertAt ?? live.current.pages.length, live.current.pages.length));
                commit([...live.current.pages.slice(0, insertAt), ...newPages, ...live.current.pages.slice(insertAt)]);
                setSources((previous) => [...previous, ...added.filter(doc => !previous.some(old => old.id === doc.id))]);
                navigateToId(newPages[0].id);
                notify(t(`已添加 ${newPages.length} 页，保存副本后合并为一个 PDF。`), 'success');
            }
            else {
                setHistory({ entries: [newPages], cursor: 0 });
                setSources(added);
                setTitle(added[0].fileName);
                setSavedPath('');
                setSavedSignature(added.length > 1 ? '' : signature(newPages));
                navigateToId(newPages[0].id);
                setZoom('fit');
                setQuery('');
                setSearchResults([]);
                setSearchedQuery('');
            }
            setSelection(new Set());
            setPanel('pages');
            if (added.some((document) => document.warnings.length))
                notify(t("文档包含处理提示\uFF0C请查看顶部的文档提示\u3002"));
        }
        catch (error) {
            if (errorMessage(error) !== cancelledRequest && !errorMessage(error).includes('SESSION_INVALIDATED:'))
                notify(errorMessage(error), 'error');
        }
        finally {
            busyRef.current = false;
            setBusy('');
        }
    }, [askPassword, commit, notify, resetWorkspace]);
    const chooseFiles = useCallback(async (append = false) => {
        if (busyRef.current || !status?.engineReady)
            return;
        try {
            const result = await open({ multiple: true, directory: false, filters: append ? pdfFilters() : [{ name: t('PDF 或可编辑项目', 'PDF or editable project'), extensions: ['pdf', 'jvp'] }, ...pdfFilters(), { name: 'Jerrivell Project', extensions: ['jvp'] }], title: append ? t("添加 PDF 到当前文档") : t('打开 PDF 或可编辑项目', 'Open PDF or editable project') });
            if (!result)
                return;
            const paths = Array.isArray(result) ? result : [result];
            if (append && live.current.pages.length) setImportRequest({ paths, range: '', position: 'after', targetPage: String(activeIndex + 1) });
            else if (!append && live.current.dirty) setReplaceRequest(paths);
            else await loadPaths(paths, append);
        }
        catch (error) {
            notify(errorMessage(error), 'error');
        }
    }, [status?.engineReady, loadPaths, notify, activeIndex]);
    const startupHandled = useRef(false);
    useEffect(() => {
        if (!isDesktop() || !status?.engineReady || startupHandled.current) return;
        startupHandled.current = true;
        void backend<string[]>('get_startup_files', undefined, 3).then(paths => {
            // A manual open made while startup IPC was pending takes precedence.
            if (paths.length && !live.current.pages.length && !busyRef.current) return loadPaths(paths, false);
        }).catch(error => notify(errorMessage(error), 'error'));
    }, [status?.engineReady, loadPaths, notify]);
    useEffect(() => {
        if (!isDesktop())
            return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void getCurrentWebviewWindow().onDragDropEvent((event) => {
            const payload = event.payload;
            if (payload.type === 'over' || payload.type === 'enter')
                setDraggingFile(!busyRef.current);
            if (payload.type === 'leave')
                setDraggingFile(false);
            if (payload.type === 'drop') {
                setDraggingFile(false);
                if (!busyRef.current && status?.engineReady)
                    void loadPaths(payload.paths, live.current.pages.length > 0);
            }
        }).then((cleanup) => { if (disposed)
            cleanup();
        else
            unlisten = cleanup; }).catch(() => { });
        return () => { disposed = true; unlisten?.(); };
    }, [loadPaths, status?.engineReady]);
    const requestExport = useCallback((parts: ExportPart[], saveWorkspace = false): Promise<boolean> => {
        if (busyRef.current || exportOpenRef.current || !parts.length) return Promise.resolve(false);
        exportOpenRef.current = true;
        return new Promise(resolve => setExportRequest({ parts, saveWorkspace, resolve }));
    }, []);
    const saveCopy = useCallback(async (): Promise<boolean> => {
        if (inlineEditingRef.current) { notify(t('请先完成或取消当前文字编辑。', 'Finish or cancel the current text edit first.')); return false; }
        const snapshot = live.current.pages;
        if (!snapshot.length) return false;
        return requestExport([{ name: `${pdfName(title || 'document')}_edited.pdf`, pages: snapshot }], true);
    }, [title, requestExport, notify]);
    const closeCurrentDocument = useCallback(async () => {
        if (busyRef.current || !live.current.pages.length) return;
        busyRef.current = true;
        setBusy(t('正在关闭 PDF…', 'Closing PDF…'));
        try {
            // Release native documents/assets before clearing the workspace. A failed
            // close leaves the visible plan intact so the user can retry or save it.
            await backend('close_all_documents', undefined, 3);
            resetWorkspace();
        } catch (error) {
            notify(t(`未能关闭 PDF：${errorMessage(error)}`, `Could not close PDF: ${errorMessage(error)}`), 'error');
        } finally { busyRef.current = false; setBusy(''); }
    }, [resetWorkspace, notify]);
    const requestCloseDocument = useCallback(() => {
        if (inlineEditingRef.current) { notify(t('请先完成或取消当前文字编辑。', 'Finish or cancel the current text edit first.')); return; }
        if (busyRef.current || exportOpenRef.current || !live.current.pages.length) return;
        if (live.current.dirty) setCloseRequest('document');
        else void closeCurrentDocument();
    }, [closeCurrentDocument, notify]);
    const cancelExport = () => {
        exportRequestRef.current?.resolve(false);
        setExportRequest(null); exportOpenRef.current = false;
        setCloseRequest(null); setReplaceRequest(null);
    };
    const finishedExport = (result: ExportResult) => {
        const request = exportRequestRef.current;
        if (!request || result.failed) return;
        if (request.saveWorkspace) { setSavedSignature(signature(request.parts[0].pages)); setSavedPath(result.results[0].path); }
        notify(t(`已导出 ${result.succeeded} 个 PDF，共 ${request.parts.reduce((sum, part) => sum + part.pages.length, 0)} 页。`, `Exported ${result.succeeded} PDFs, ${request.parts.reduce((sum, part) => sum + part.pages.length, 0)} pages.`), 'success');
        setExportRequest(null); exportOpenRef.current = false; request.resolve(true);
    };
    const documentToolsBusy = useCallback((working: boolean) => {
        busyRef.current = working; setBusy(working ? t('正在处理文档方案…', 'Processing document plan…') : '');
    }, []);
    const addGeneratedPages = (document: DocumentInfo, replaceIds: string[] | null, insertAt: number, overlays: PageOverlay[] = []) => {
        const snapshot = live.current.pages;
        sourceRegistry.current.set(normalizePath(document.path), document);
        setSources(previous => [...previous.filter(source => source.id !== document.id), document]);
        const fresh: WorkspacePage[] = document.pages.map(page => ({ id: nextId(), documentId: document.id, pageIndex: page.index, rotation: 0, width: page.width, height: page.height, sourceName: document.fileName, overlays, contentEdits: [], decorations: [] }));
        if (replaceIds) {
            const indices = new Map(replaceIds.map((id, index) => [id, index]));
            commit(snapshot.map(page => { const index = indices.get(page.id); return index === undefined ? page : { ...fresh[index], id: page.id, sourceName: page.sourceName }; }));
        } else {
            const at = Math.max(0, Math.min(insertAt, snapshot.length));
            commit([...snapshot.slice(0, at), ...fresh, ...snapshot.slice(at)]);
            if (fresh[0]) navigateToId(fresh[0].id);
            if (!snapshot.length) { setTitle(document.fileName); setSavedSignature(''); setSavedPath(''); }
        }
        setOriginalSelected(''); originalInspectionRef.current = null; setOriginalInspection(null);
        setPageToolsOpen(false); setLineOpen(false); setSelection(new Set());
        notify(t('页面方案已更新，可撤销；请保存副本。', 'Page plan updated. Undo is available; save a copy.'), 'success');
    };
    const openPixelEdit = async (wholePage = false) => {
        if (busyRef.current || !currentPage) return;
        const page = currentPage, overlay = page.overlays?.find(value => value.id === activeOverlayId);
        if (!wholePage && (!overlay || overlay.locked)) return;
        editorBusyChanged(true);
        try {
            const image = wholePage ? await backend<ImageAsset>('rasterize_page_asset',{page:pageReference(page)},3) : await backend<ImageAsset>('get_image_asset',{assetId:overlay!.assetId},3);
            if (live.current.pages.some(value=>value.id===page.id && value.documentId===page.documentId)) { setPixelEdit({page,image,overlayId:wholePage?undefined:overlay!.id}); setOriginalOpen(false); }
        } catch(reason) { notify(errorMessage(reason),'error'); }
        finally { editorBusyChanged(false); }
    };
    const applyPixelEdit = async (image: ImageAsset) => {
        if (!pixelEdit) return false;
        const target = live.current.pages.find(value=>value.id===pixelEdit.page.id);
        if (!target || JSON.stringify(pageReference(target))!==JSON.stringify(pageReference(pixelEdit.page))) throw new Error(t('页面已变化，请重新打开图像编辑。','The page changed. Reopen the image editor.'));
        if (pixelEdit.overlayId) {
            updatePageOverlays(target.id,(target.overlays??[]).map(value=>value.id===pixelEdit.overlayId?{...value,assetId:image.id,textSource:undefined,markSource:undefined,leaderFor:undefined}:value));
        } else {
            const dimensions=visiblePageSize(target);
            const document=await backend<DocumentInfo>('generate_pages',{request:{kind:'blank',width:dimensions.width,height:dimensions.height,count:1}},3);
            addGeneratedPages(document,[target.id],0,[{id:nextId(),assetId:image.id,x:0,y:0,width:1,height:1,opacity:1,blendMode:'normal'}]);
        }
        return true;
    };
    const quickDuplicate = () => {
        if (busyRef.current) return;
        const snapshot = live.current.pages, selected = snapshot.filter(page => selection.size ? selection.has(page.id) : page.id === currentPage?.id);
        if (!selected.length || snapshot.length + selected.length > 5000) { notify(t('复制后最多 5000 页。', 'The workspace supports up to 5000 pages.'), 'error'); return; }
        const at = Math.max(...selected.map(page => snapshot.findIndex(item => item.id === page.id))) + 1;
        const copies = selected.map(page => duplicatePage(page, nextId()));
        commit([...snapshot.slice(0, at), ...copies, ...snapshot.slice(at)]);
        navigateToId(copies[0].id); setSelection(new Set(copies.map(page => page.id)));
    };
    const quickBlank = async () => {
        if (busyRef.current) return;
        setOriginalOpen(false); setEditorOpen(false); setTextDrawMode(false); setMarkOpen(false);
        if (live.current.pages.length >= 5000) { notify(t('工作区最多 5000 页。', 'The workspace supports up to 5000 pages.'), 'error'); return; }
        documentToolsBusy(true);
        try {
            const doc = await backend<DocumentInfo>('generate_pages', { request: { kind: 'blank', width: 595.2756, height: 841.8898, count: 1 } }, 3);
            addGeneratedPages(doc, null, activeIndex + 1);
        } catch (reason) { notify(errorMessage(reason), 'error'); }
        finally { documentToolsBusy(false); }
    };
    const exportCurrentPage = useCallback(async () => {
        if (busyRef.current || !currentPage)
            return;
        try {
            const outputPath = await save({ title: t("导出当前页为 PNG"), defaultPath: t(`${pdfName(title)}_第${activeIndex + 1}页.png`), filters: [{ name: t("PNG 图片"), extensions: ['png'] }] });
            if (!outputPath)
                return;
            busyRef.current = true;
            setBusy(t("正在导出当前页\u2026"));
            await backend('export_page', { page: pageReference(currentPage), targetWidth: 2400, outputPath });
            notify(t(`第 ${activeIndex + 1} 页已导出为 PNG。`), 'success');
        }
        catch (error) {
            notify(errorMessage(error), 'error');
        }
        finally {
            busyRef.current = false;
            setBusy('');
        }
    }, [activeIndex, currentPage, notify, title]);
    const undo = useCallback(() => { if (!busyRef.current)
        setHistory((previous) => ({ ...previous, cursor: Math.max(0, previous.cursor - 1) })); }, []);
    const redo = useCallback(() => { if (!busyRef.current)
        setHistory((previous) => ({ ...previous, cursor: Math.min(previous.entries.length - 1, previous.cursor + 1) })); }, []);
    const affectedIds = useMemo(() => selection.size ? selection : new Set(currentPage ? [currentPage.id] : []), [selection, currentPage]);
    const selectRange = useCallback(() => {
        if (busyRef.current) return;
        try {
            const indices = parsePageRange(rangeInput, pages.length);
            setSelection(new Set(indices.map(index => pages[index].id)));
            if (indices.length) navigateToId(pages[indices[0]].id);
        } catch (error) { notify(rangeErrorMessage(error, pages.length), 'error'); }
    }, [rangeInput, pages, notify]);
    const extractSelectedPages = useCallback(async () => {
        if (busyRef.current || !pages.length) return;
        const snapshot = pages.filter(page => affectedIds.has(page.id));
        if (snapshot.length) await requestExport([{ name: `${pdfName(title || 'document')}_selected.pdf`, pages: snapshot }]);
    }, [pages, affectedIds, title, requestExport]);
    const submitImport = async () => {
        if (!importRequest || busyRef.current) return;
        let insertAt = pages.length;
        if (importRequest.position === 'after') insertAt = activeIndex + 1;
        if (importRequest.position === 'before') {
            const page = Number(importRequest.targetPage);
            if (!Number.isSafeInteger(page) || page < 1 || page > pages.length) { setImportError(t(`插入页码必须在 1～${pages.length} 之间。`, `The insertion page must be between 1 and ${pages.length}.`)); return; }
            insertAt = page - 1;
        }
        try { parsePageRange(importRequest.range, 5000, true); }
        catch(error) { setImportError(rangeErrorMessage(error, 5000)); return; }
        const request = importRequest; setImportRequest(null); setImportError('');
        await loadPaths(request.paths, true, { range: request.range, insertAt });
    };
    const rotatePages = useCallback(() => { if (!busyRef.current && pages.length)
        commit(pages.map((page) => affectedIds.has(page.id) ? rotatePageClockwise(page) : page)); }, [pages, affectedIds, commit]);
    const deletePages = useCallback(() => {
        if (busyRef.current || !pages.length)
            return;
        if (affectedIds.size >= pages.length) {
            notify(t("文档至少需要保留一页\u3002"), 'info');
            return;
        }
        const next = pages.filter((page) => !affectedIds.has(page.id));
        commit(next);
        if (affectedIds.has(activeId))
            navigateToId(next[Math.min(activeIndex, next.length - 1)].id);
        setSelection(new Set());
        notify(t(`已删除 ${pages.length - next.length} 页，可撤销。`));
    }, [pages, affectedIds, commit, activeId, activeIndex, notify]);
    const movePages = useCallback((direction: -1 | 1) => {
        if (busyRef.current || !pages.length)
            return;
        const next = [...pages];
        if (direction === -1) {
            for (let i = 1; i < next.length; i++)
                if (affectedIds.has(next[i].id) && !affectedIds.has(next[i - 1].id))
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
        }
        else {
            for (let i = next.length - 2; i >= 0; i--)
                if (affectedIds.has(next[i].id) && !affectedIds.has(next[i + 1].id))
                    [next[i], next[i + 1]] = [next[i + 1], next[i]];
        }
        if (next.some((page, index) => page.id !== pages[index].id))
            commit(next);
    }, [affectedIds, pages, commit]);
    const reorderPage = useCallback((source: string, target: string, side: 'before' | 'after') => {
        if (busyRef.current) return;
        const snapshot = live.current.pages;
        const next = reorderPages(snapshot, source, target, side, selection);
        if (next === snapshot) return;
        commit(next);
        navigateToId(source);
        notify(t('页序已更新，可撤销。', 'Page order updated. You can undo this move.'));
    }, [selection, commit, navigateToId, notify]);
    const goToPage = useCallback((index: number) => { if (!busyRef.current && pages.length)
        navigateToId(pages[Math.max(0, Math.min(index, pages.length - 1))].id); }, [pages]);
    const applyPageInput = () => {
        const value = Number(pageInput);
        if (Number.isInteger(value) && value > 0) {
            const index = Math.max(0, Math.min(value - 1, pages.length - 1));
            goToPage(index);
            setPageInput(String(index + 1));
        }
        else
            setPageInput(String(activeIndex + 1));
    };
    const pageDimensions = currentPage ? visiblePageSize(currentPage) : { width: 595, height: 842 };
    const displayedWidth = currentPage ? fittedPageWidth(currentPage, viewerSize, zoom) : 595;
    const zoomPercent = Math.round(displayedWidth / pageDimensions.width * 100);
    const changeZoom = useCallback((delta: number) => setZoom(clampZoom(Math.round((zoomPercent + delta) / 10) * 10)), [zoomPercent]);
    const addDrawnMark = (pageId: string, mark: MarkGeometry, settings: MarkSettings) => {
        if (busyRef.current) return;
        const page = live.current.pages.find(item => item.id === pageId);
        if (!page) return;
        if ((page.overlays?.length ?? 0) + (settings.tool === 'callout' ? 2 : 1) > 30) { notify(t('当前页面最多添加 30 个内容对象。', 'A page can contain up to 30 added objects.'), 'error'); return; }
        try {
            let overlay: PageOverlay = { id: nextId(), assetId: '', ...mark.bounds, opacity: settings.opacity, rotation: 0,
                blendMode: settings.tool === 'highlight' ? 'multiply' : 'normal', markSource: { geometry: mark, color: settings.color } };
            if (settings.tool === 'callout') {
                const end = mark.points.at(-1)!, before = mark.points.at(-2)!;
                const width = Math.min(180, mark.pageWidth * .4), height = 38;
                const text: PageOverlay = { id: nextId(), assetId: '', x: Math.max(0, Math.min(1 - width / mark.pageWidth, end.x < before.x ? end.x - width / mark.pageWidth : end.x)),
                    y: Math.max(0, Math.min(1 - height / mark.pageHeight, end.y - height / mark.pageHeight / 2)), width: width / mark.pageWidth, height: height / mark.pageHeight,
                    opacity: 1, rotation: 0, textSource: { content: t('文字说明', 'Label'), fontSize: 12, color: settings.color, bold: false,
                        fontFamily: DEFAULT_FONT_FAMILY, padding: 0, frame: { width, height, autoHeight: true } } };
                overlay = attachLeader({ ...overlay, leaderFor: text.id }, text);
                updatePageOverlays(pageId, [...(page.overlays ?? []), overlay, text]);
                setActiveOverlayId(text.id);
                notify(t('已创建文字引线。双击文字修改；移动文字保留指向，Alt 拖动整体移动。', 'Text callout created. Double-click its label to edit. Move the label to retain the target; Alt-drag moves both.'));
            } else { updatePageOverlays(pageId, [...(page.overlays ?? []), overlay]); setActiveOverlayId(overlay.id); }
            if (['polyline', 'polyarrow', 'callout'].includes(settings.tool)) setMarkSettings(value => ({ ...value, tool: 'select' }));
        } catch (error) { notify(errorMessage(error), 'error'); }
    };
    const duplicateMark = () => {
        if (busyRef.current || !currentPage) return;
        const overlays = currentPage.overlays ?? [];
        const selected = overlays.find(item => item.id === activeOverlayId);
        if (!selected || overlays.length >= 30) return;
        const copy = duplicatedOverlay(selected, nextId(), pageDimensions.width, pageDimensions.height);
        updateOverlays([...overlays, copy]); setActiveOverlayId(copy.id);
    };
    const styleMark = (patch: MarkStylePatch) => {
        if (!currentPage || busyRef.current) return;
        updateOverlays((currentPage.overlays ?? []).map(item => {
            if (item.id !== activeOverlayId || item.locked || !item.markSource) return item;
            const source = item.markSource;
            const geometry = createMarkGeometry(source.geometry.points, { ...source.geometry, ...patch, color: patch.color ?? source.color, opacity: item.opacity }, pageDimensions.width, pageDimensions.height);
            return geometry ? { ...item, ...geometry.bounds, opacity: patch.opacity ?? item.opacity, markSource: { geometry, color: patch.color ?? source.color } } : item;
        }));
    };
    const originalPlanKey = currentPage ? `${currentPage.id}:${JSON.stringify(pageReference(currentPage))}` : '';
    const visibleOriginal = originalInspection?.key === originalPlanKey ? originalInspection.data : undefined;
    useEffect(() => {
        if (!originalOpen || !currentPage) return;
        if (originalInspectionRef.current?.key === originalPlanKey) { setOriginalLoading(false); return; }
        let cancelled = false;
        setOriginalLoading(true); setOriginalError('');
        void backend<ContentInspection>('inspect_page_content', { page: pageReference(currentPage) }).then(data => {
            if (cancelled) return;
            const result = { key: originalPlanKey, data };
            originalInspectionRef.current = result; setOriginalInspection(result);
        }).catch(error => { if (!cancelled && errorMessage(error) !== cancelledRequest) setOriginalError(errorMessage(error)); })
          .finally(() => { if (!cancelled) setOriginalLoading(false); });
        return () => { cancelled = true; };
    }, [originalOpen, originalPlanKey, originalRefresh]);
    useEffect(() => {
        if (!query.trim() || !sources.length) {
            setSearchResults([]);
            setSearchedQuery('');
            setSearchError('');
            setSearching(false);
            return;
        }
        let cancelled = false;
        setSearching(true);
        setSearchError('');
        const timer = window.setTimeout(async () => {
            try {
                const results = await backend<SearchMatch[]>('search_pages', { pages: pages.map(pageReference), query: query.trim() });
                if (cancelled)
                    return;
                const mapped: WorkspaceMatch[] = [];
                pages.forEach((page, workspaceIndex) => {
                    const match = results.find((result) => result.pageIndex === workspaceIndex);
                    if (match)
                        mapped.push({ ...match, id: page.id, workspaceIndex });
                });
                setSearchResults(mapped);
                setSearchedQuery(query.trim());
            }
            catch (error) {
                if (!cancelled)
                    setSearchError(errorMessage(error));
            }
            finally {
                if (!cancelled)
                    setSearching(false);
            }
        }, 350);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [query, pages, sources]);
    useEffect(() => {
        const handleKey = (event: globalThis.KeyboardEvent) => {
            if (pageToolsOpen || lineOpen || exportRequest) {
                if ((event.ctrlKey || event.metaKey) && ['o', 's', 'p', 'f', 'w'].includes(event.key.toLowerCase())) event.preventDefault();
                return;
            }
            if (printOpen) {
                if ((event.ctrlKey || event.metaKey) && ['o', 's', 'p', 'f', 'w'].includes(event.key.toLowerCase())) event.preventDefault();
                return;
            }
            if (passwordRequest || replaceRequest || importRequest || closeRequest || showShortcuts || showWarnings || settingsOpen) {
                if (event.key === 'Escape' && !passwordRequest) {
                    setReplaceRequest(null);
                    setImportRequest(null);
                    setCloseRequest(null);
                    setShowShortcuts(false);
                    setShowWarnings(false);
                    setSettingsOpen(false);
                }
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w') event.preventDefault();
                return;
            }
            const editing = event.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable || Boolean(event.target.closest('.overlay-editor, .original-editor')));
            const fieldOwnsHistory = editing && !(event.target instanceof HTMLInputElement && event.target.type === 'range' && event.target.closest('.mark-toolbar'));
            const modifier = event.ctrlKey || event.metaKey;
            if (modifier && event.key.toLowerCase() === 'w') {
                event.preventDefault();
                requestCloseDocument();
            }
            else if (modifier && event.key.toLowerCase() === 'o') {
                event.preventDefault();
                void chooseFiles(event.shiftKey);
            }
            else if (modifier && event.key.toLowerCase() === 's') {
                event.preventDefault();
                event.shiftKey ? void saveProject() : void saveCopy();
            }
            else if (modifier && event.key.toLowerCase() === 'p') {
                event.preventDefault();
                openPrint();
            }
            else if (modifier && event.key.toLowerCase() === 'f' && pages.length) {
                event.preventDefault();
                setPanel('search'); setSidebarCollapsed(false);
                window.setTimeout(() => searchField.current?.focus(), 30);
            }
            else if (!fieldOwnsHistory && modifier && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                event.shiftKey ? redo() : undo();
            }
            else if (!fieldOwnsHistory && modifier && event.key.toLowerCase() === 'y') {
                event.preventDefault();
                redo();
            }
            else if (!editing && modifier && event.key.toLowerCase() === 'a' && pages.length) {
                event.preventDefault();
                setSelection(new Set(pages.map((page) => page.id)));
            }
            else if (!editing && !modifier && (event.key === 'Delete' || event.key === 'Backspace') && markOpen) {
                event.preventDefault();
                if (!busyRef.current && currentPage) updateOverlays((currentPage.overlays ?? []).filter(item => item.id !== activeOverlayId || item.locked));
            }
            else if (!editing && !modifier && event.key === 'Delete') {
                event.preventDefault(); deletePages();
            }
            else if (!editing && modifier && event.key.toLowerCase() === 'd' && markOpen) { event.preventDefault(); duplicateMark(); }
            else if (!editing && !modifier && event.key.toLowerCase() === 'r') {
                event.preventDefault();
                rotatePages();
            }
            else if (!editing && event.altKey && event.key === 'ArrowUp') {
                event.preventDefault();
                movePages(-1);
            }
            else if (!editing && event.altKey && event.key === 'ArrowDown') {
                event.preventDefault();
                movePages(1);
            }
            else if (!editing && (event.key === 'ArrowLeft' || event.key === 'PageUp')) {
                event.preventDefault();
                goToPage(activeIndex - 1);
            }
            else if (!editing && (event.key === 'ArrowRight' || event.key === 'PageDown')) {
                event.preventDefault();
                goToPage(activeIndex + 1);
            }
            else if (!editing && event.key === 'Escape') {
                setSelection(new Set());
                if (markOpen) setMarkSettings(value => ({ ...value, tool: 'select' }));
            }
            else if (!editing && !modifier && event.key === 'Home') { event.preventDefault(); goToPage(0); }
            else if (!editing && !modifier && event.key === 'End') { event.preventDefault(); goToPage(pages.length - 1); }
            else if (!editing && modifier && event.key === '1') { event.preventDefault(); setZoom('page'); }
            else if (!editing && modifier && (event.key === '+' || event.key === '=')) {
                event.preventDefault();
                changeZoom(10);
            }
            else if (!editing && modifier && event.key === '-') {
                event.preventDefault();
                changeZoom(-10);
            }
            else if (!editing && modifier && event.key === '0') {
                event.preventDefault();
                setZoom('fit');
            }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [pageToolsOpen, lineOpen, exportRequest, currentPage, activeOverlayId, updateOverlays, markOpen, printOpen, passwordRequest, replaceRequest, importRequest, closeRequest, showShortcuts, showWarnings, settingsOpen, chooseFiles, saveCopy, saveProject, requestCloseDocument, openPrint, pages, redo, undo, deletePages, rotatePages, movePages, goToPage, activeIndex, changeZoom]);
    const selectThumbnail = (event: React.MouseEvent, page: WorkspacePage, index: number) => {
        if (busyRef.current) return;
        if (event.shiftKey) {
            const start = Math.min(activeIndex, index);
            const end = Math.max(activeIndex, index);
            setSelection(new Set(pages.slice(start, end + 1).map((item) => item.id)));
        }
        else if (event.ctrlKey || event.metaKey) {
            setSelection((previous) => { const next = new Set(previous); next.has(page.id) ? next.delete(page.id) : next.add(page.id); return next; });
        }
        else {
            navigateToId(page.id);
            setSelection(new Set());
        }
    };
    return <div className="app-shell" ref={appRoot} onPointerDownCapture={event=>{
        if(inlineEditingRef.current && event.target instanceof Element && !event.target.closest('[data-inline-text-edit]')){
            window.dispatchEvent(new Event(finishInlineTextEvent));
            if(inlineEditingRef.current){event.preventDefault();event.stopPropagation();}
        }
    }}>
    <div className="app-main">
      <header className="app-header" ref={appHeader}>
        <div className="header-title"><div className="brand-lockup" aria-label={t("Jerrivell PDF")}><img className="brand-icon" src={brandIcon} alt=""/><div className="wordmark">Jerrivell<span>PDF</span></div></div><div className="header-divider"/><div className="document-title-group"><h1 title={title || t("你的 PDF 工作台")}>{title || t("你的 PDF 工作台")}</h1><div className="document-subtitle">{pages.length ? <><span className={dirty ? 'status-dot modified' : 'status-dot'}/>{dirty ? t("有未保存的修改") : projectPath ? t("可编辑项目", "Editable project") : savedPath ? t("副本已保存") : t("原始文档")}<span className="meta-dot">·</span>{t(`${pages.length} 页`, `${pages.length} pages`)}{sources.length > 1 && <><span className="meta-dot">·</span>{t(`${sources.length} 个来源`, `${sources.length} sources`)}</>}</> : <>{t("Jerry 的本地 PDF 工作台")}</>}</div></div></div>
        <nav className="floating-navigation" aria-label={t('主导航')}>
          <button className="rail-button rail-open" onClick={() => void chooseFiles()} disabled={!!busy || !status?.engineReady} title={t('打开 PDF · Ctrl+O')}><FolderOpen size={18}/><span>{t('打开')}</span></button>
          <button className={`rail-button ${pages.length && panel === 'pages' && !sidebarCollapsed && !pageToolsOpen ? 'active' : ''}`} aria-pressed={!!pages.length && panel === 'pages' && !sidebarCollapsed && !pageToolsOpen} onClick={() => { setPanel('pages'); setSidebarCollapsed(false); }} disabled={!pages.length} title={t('页面工作台')}><Layers3 size={18}/><span>{t('页面')}</span></button>
          <button className={`rail-button ${pages.length && panel === 'search' && !sidebarCollapsed ? 'active' : ''}`} aria-pressed={!!pages.length && panel === 'search' && !sidebarCollapsed} onClick={() => { setPanel('search'); setSidebarCollapsed(false); window.setTimeout(() => searchField.current?.focus(), 50); }} disabled={!pages.length} title={t('查找文字 · Ctrl+F')}><Search size={18}/><span>{t('查找')}</span></button>
          <button className={`rail-button ${pageToolsOpen ? 'active' : ''}`} aria-pressed={pageToolsOpen} onClick={() => { setEditorOpen(false); setTextDrawMode(false); setOriginalOpen(false); setMarkOpen(false); setPageToolsOpen(true); }} disabled={!!busy || !status?.engineReady} title={t('页面与批量工具', 'Page and batch tools')}><Wrench size={18}/><span>{t('工具', 'Tools')}</span></button>
          <button className={`rail-button ${settingsOpen ? 'active' : ''}`} aria-pressed={settingsOpen} disabled={!!busy} onClick={() => setSettingsOpen(true)} title={t('默认应用与打开方式设置', 'Default app and Open with settings')}><Settings2 size={18}/><span>{t('设置', 'Settings')}</span></button>
        </nav>
        <div className="header-actions">{pages.length > 0 && <button className="button secondary" disabled={!!busy} onClick={() => void saveProject()} title={t("保存可编辑项目 · Ctrl+Shift+S", "Save editable project · Ctrl+Shift+S")}><Save size={16}/><span>{t("保存项目", "Save project")}</span></button>}<select className="language-select" aria-label={t("界面语言", "Interface language")} value={language} onChange={event => setLanguage(event.target.value as 'zh-CN' | 'en-US')} disabled={!!busy}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select>{pages.length > 0 ? <><button className="button secondary" disabled={!!busy} onClick={() => void chooseFiles(true)} title={t("添加 PDF \u00B7 Ctrl+Shift+O")}><FilePlus2 size={16}/><span>{t("添加 PDF")}</span></button><button className="button secondary close-document-button" disabled={!!busy} onClick={requestCloseDocument} title={t("关闭当前 PDF · Ctrl+W", "Close current PDF · Ctrl+W")} aria-label={t("关闭当前 PDF", "Close current PDF")}><X size={16}/><span>{t("关闭 PDF", "Close PDF")}</span></button><button className="button primary save-button" disabled={!!busy} onClick={() => void saveCopy()} title={t("保存副本 \u00B7 Ctrl+S")}><Save size={16}/><span>{t("保存副本")}</span></button></> : <span className="privacy-pill"><span />{t("本地处理 \u00B7 文件不上传")}</span>}</div>
      </header>

      {!status?.engineReady && !checkingEngine && <div className="engine-banner"><CircleAlert size={16}/><span>{t(status?.message || "PDF 引擎暂不可用。")}</span>{isDesktop() && <button onClick={() => void checkEngine()}>{t("重新检测")}</button>}</div>}

      {pages.length === 0 ? <main className="welcome">
        <div className="welcome-topline"><span className="workspace-label"><span className="tiny-grid">✦</span> LOCAL WORKSPACE</span><span className="edition-label">{t("为文档留一点呼吸的空间")}</span></div>
        <section className={`welcome-dropzone ${draggingFile ? 'drag-active' : ''}`}>
          <div className="welcome-copy"><span className="eyebrow"><span />{t("从一份 PDF 开始")}</span><h2>{t("每一页\uFF0C")}<br />{t("都在掌控之中")}<span className="heading-period">。</span></h2><p>{t("阅读\u3001搜索\u3001整理与合并\u3002")}<br />{t("把繁琐留给工具\uFF0C把专注留给自己\u3002")}</p><button className="button primary welcome-open" onClick={() => void chooseFiles()} disabled={!!busy || !status?.engineReady}>{busy || checkingEngine ? <LoaderCircle size={18} className="spin"/> : <FolderOpen size={18}/>}{t("打开 PDF")}<kbd>Ctrl O</kbd></button><span className="drop-hint">{t("或将文件拖到这里\uFF0C也可以一次打开多份")}</span></div>
          <div className="paper-scene" aria-hidden="true"><div className="scene-orbit orbit-one"/><div className="scene-orbit orbit-two"/><div className="floating-spark spark-one">✦</div><div className="floating-spark spark-two">+</div><div className="paper-card paper-back"/><div className="paper-card paper-front"><div className="paper-top"><span className="paper-logo"/><span className="paper-date">YOUR NEXT CHAPTER</span></div><div className="paper-mini-title">Ideas, in order.</div><div className="paper-mini-subtitle">Every page has a place.</div><div className="paper-art"><div className="art-disc"/><div className="art-arch"/><div className="art-square"/></div><div className="paper-lines"><i /><i /><i /></div><div className="paper-footer"><span>RIVULEAF / NOTES</span><span>01</span></div></div><div className="scene-badge"><Check size={14} strokeWidth={2.5}/>{t("让文档井然有序")}</div></div>
        </section>
        <section className="welcome-features" aria-label={t("工作台能力")}><div className="feature-card"><span className="feature-icon violet"><Layers3 size={20}/></span><div><h3>{t("页面\uFF0C自由组合")}</h3><p>{t("拖动排序\u3001旋转与删除\uFF0C多份文档轻松合一\u3002")}</p></div><span className="feature-number">01</span></div><div className="feature-card"><span className="feature-icon blue"><Search size={20}/></span><div><h3>{t("阅读\uFF0C找到重点")}</h3><p>{t("清晰预览\u3001文字搜索\uFF0C一步跳转到目标页面\u3002")}</p></div><span className="feature-number">02</span></div><div className="feature-card"><span className="feature-icon mint"><ShieldCheck size={20}/></span><div><h3>{t("文件\uFF0C留在本地")}</h3><p>{t("离线处理并保存副本\uFF0C让原始文件安心保留\u3002")}</p></div><span className="feature-number">03</span></div></section>
        <footer className="welcome-footer"><span><span className={`status-dot ${status?.engineReady ? '' : 'muted'}`}/>{checkingEngine ? t("正在准备工作台\u2026") : status?.engineReady ? t("工作台已就绪") : t("等待桌面环境")}</span><span>OPEN SOURCE. OPEN POSSIBILITIES.</span></footer>
      </main> : <>
        <div className="workspace-toolbar"><div className="toolbar-group history-tools"><button className="icon-button" title={t("撤销 \u00B7 Ctrl+Z")} aria-label={t("撤销")} disabled={!!busy || history.cursor === 0} onClick={undo}><Undo2 size={17}/></button><button className="icon-button" title={t("重做 \u00B7 Ctrl+Shift+Z")} aria-label={t("重做")} disabled={!!busy || history.cursor === history.entries.length - 1} onClick={redo}><Redo2 size={17}/></button><span className="toolbar-divider"/><button className="tool-button" onClick={rotatePages} disabled={!!busy} title={t("顺时针旋转 \u00B7 R")}><RotateCw size={16}/><span>{t("旋转")}</span></button><button className="tool-button danger-tool" onClick={deletePages} disabled={!!busy || affectedIds.size === pages.length} title={t("删除选中页面 \u00B7 Delete")}><Trash2 size={16}/><span>{t("删除")}</span></button></div><div className="toolbar-center">{selection.size > 0 ? <span className="selection-pill">{t(`已选择 ${selection.size} 页`, `${selection.size} pages selected`)}<button onClick={() => setSelection(new Set())} title={t("清除选择")} aria-label={t("清除选择")}><X size={12}/></button></span> : <span className="toolbar-context">{t("页面工作台")}</span>}</div><div className="toolbar-group"><button className="tool-button" disabled={!!busy} onClick={() => { setEditorOpen(false); setTextDrawMode(false); setOriginalOpen(false); setMarkOpen(false); setPageToolsOpen(true); }} title={t('图片转 PDF、拆分、页码、水印和裁剪', 'Images to PDF, splitting, numbering, watermarks and crop')}><Wrench size={16}/><span>{t('页面工具', 'Page tools')}</span></button><button className={`tool-button ${markOpen ? 'active' : ''}`} aria-pressed={markOpen} disabled={!!busy} onClick={() => { setEditorOpen(false); setTextDrawMode(false); setOriginalOpen(false); setMarkOpen(value => !value); }} title={t('直接在页面上框选高亮、色块或绘制图形', 'Draw highlights, color blocks and shapes directly on the page')}><Highlighter size={16}/><span>{t('标记', 'Mark')}</span></button><button className={`tool-button content-edit-button ${editorOpen ? 'active' : ''}`} disabled={!!busy} aria-pressed={editorOpen} onClick={() => { setOriginalOpen(false); setMarkOpen(false); setEditorOpen(value => !value); }} title={t('添加文字、图片、图章和签名', 'Add text, images, stamps and signatures')}><PenLine size={16}/><span>{t('添加内容', 'Add content')}</span></button><button className={`tool-button ${originalOpen ? 'active' : ''}`} disabled={!!busy} aria-pressed={originalOpen} onClick={() => { setEditorOpen(false); setTextDrawMode(false); setMarkOpen(false); setOriginalOpen(value => !value); }} title={t('编辑 PDF 原有文字与图片对象', 'Edit original PDF text and image objects')}><FileText size={16}/><span>{t('编辑原文', 'Edit original')}</span></button><button className="tool-button" disabled={!!busy} onClick={() => { setEditorOpen(false); setTextDrawMode(false); setMarkOpen(false); setOriginalOpen(true); setLineOpen(true); }} title={t('识别文字行，调整字距与对齐并预览', 'Group text runs, adjust spacing and alignment, and compare')}><FileText size={16}/><span>{t('文字行', 'Text lines')}</span></button><button className="tool-button" disabled={!!busy} onClick={openPrint} title={t("打印 · Ctrl+P", "Print · Ctrl+P")}><Printer size={16}/><span>{t("打印", "Print")}</span></button><button className="tool-button export-button" disabled={!!busy} onClick={() => void exportCurrentPage()} title={t("将当前页面导出为 PNG 图片")}><ImageDown size={16}/><span>{t("导出本页")}</span></button>{warnings.length > 0 && <button className="warning-button" onClick={() => setShowWarnings(true)} title={t("查看文档提示")}><CircleAlert size={15}/><span>{warnings.length}</span></button>}</div></div>
        <div ref={workspaceBody} className={`workspace-body ${(editorOpen || originalOpen) ? 'editor-open' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
          <aside className="document-panel"><div className="panel-tabs"><button className={panel === 'pages' ? 'selected' : ''} onClick={() => setPanel('pages')}><Layers3 size={15}/>{t("页面")}<span>{pages.length}</span></button><button className={panel === 'search' ? 'selected' : ''} onClick={() => { setPanel('search'); setSidebarCollapsed(false); window.setTimeout(() => searchField.current?.focus(), 30); }}><Search size={15}/>{t("查找")}</button></div>
            {panel === 'pages' ? <><div className="page-panel-tools"><button className="text-button" onClick={() => setSelection(selection.size === pages.length ? new Set() : new Set(pages.map((page) => page.id)))} disabled={!!busy}><CheckCheck size={14}/>{selection.size === pages.length ? t("取消全选") : t("选择全部")}</button><div><button className="icon-button small" onClick={() => movePages(-1)} disabled={!!busy} title={t("前移选中页 \u00B7 Alt+\u2191")} aria-label={t("前移选中页")}><ArrowUp size={14}/></button><button className="icon-button small" onClick={() => movePages(1)} disabled={!!busy} title={t("后移选中页 \u00B7 Alt+\u2193")} aria-label={t("后移选中页")}><ArrowDown size={14}/></button></div></div><div className="page-quick-actions"><button disabled={!!busy} onClick={quickDuplicate} title={t('复制所选页面，保留内容与标记','Duplicate selected pages with content and marks')}><Copy size={14}/>{t('复制页','Duplicate pages')}</button><button disabled={!!busy} onClick={() => void quickBlank()} title={t('在当前页后插入 A4 空白页','Insert an A4 blank page after the current page')}><FilePlus2 size={14}/>{t('空白页','Blank page')}</button></div><div className="page-range-controls">
                <label htmlFor="page-range">{t('按页码选择', 'Select by page range')}</label>
                <div className="range-input-row"><input id="page-range" aria-label={t('页码范围', 'Page range')} value={rangeInput} placeholder="1-3,5" onChange={event => setRangeInput(event.target.value)} onKeyDown={event => { if(event.key === 'Enter') { event.preventDefault(); selectRange(); } }} disabled={!!busy}/><button className="range-apply" onClick={selectRange} disabled={!!busy}>{t('选择', 'Select')}</button></div>
                <div className="range-actions"><button onClick={deletePages} disabled={!!busy || affectedIds.size >= pages.length}>{t('删除所选', 'Remove selected')}</button><button onClick={() => void extractSelectedPages()} disabled={!!busy}>{t('提取为 PDF', 'Extract PDF')}</button></div>
                <small>{t('提取保留当前页序；未多选时使用当前页。', 'Extraction keeps page order. Without a selection, it uses the current page.')}</small>
            </div><PageThumbnails pages={pages} activeId={currentPage?.id ?? ''} selection={selection} busy={!!busy} onSelect={selectThumbnail} onToggle={id => setSelection(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; })} onReorder={reorderPage} onAdd={() => void chooseFiles(true)}/>
            <div className="panel-footnote"><GripVertical size={12}/>{t("拖动页面调整顺序")}</div></> : <><div className="search-box"><Search size={16}/><input ref={searchField} aria-label={t("查找文档中的文字")} placeholder={t("查找文档中的文字")} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => { if (event.key === 'Escape') {
            setQuery('');
            event.currentTarget.blur();
        } }}/>{query && <button aria-label={t("清空查找")} onClick={() => setQuery('')}><X size={14}/></button>}</div><div className="search-results">{searching ? <div className="panel-message"><LoaderCircle size={20} className="spin"/><p>{t("正在查找\u2026")}</p></div> : searchError ? <div className="panel-message error"><CircleAlert size={20}/><p>{t(searchError)}</p></div> : !query ? <div className="panel-message"><Search size={28} strokeWidth={1.3}/><h3>{t("找到你需要的内容")}</h3><p>{t("搜索文档内的文字\uFF0C点击结果跳转到对应页面\u3002")}</p><span>{t("扫描图片中的文字暂不支持识别")}</span></div> : searchResults.length ? <><div className="search-summary">{t(`在 ${searchResults.length} 页中找到 ${searchResults.reduce((sum, result) => sum + result.matchCount, 0)} 处结果`, `${searchResults.reduce((sum, result) => sum + result.matchCount, 0)} matches on ${searchResults.length} pages`)}</div>{searchResults.map((result) => <button className={`search-result ${currentPage?.id === result.id ? 'active' : ''}`} key={result.id} onClick={() => navigateToId(result.id)}><span className="result-page">{t(`第 ${result.workspaceIndex + 1} 页`, `Page ${result.workspaceIndex + 1}`)}<span>{t(`${result.matchCount} 处`, `${result.matchCount} matches`)}</span></span><span className="result-preview">{result.preview || searchedQuery}</span></button>)}</> : <div className="panel-message"><Search size={24}/><h3>{t("没有找到匹配文字")}</h3><p>{t("试试更短的关键词\uFF0C或检查文档是否为扫描图片\u3002")}</p></div>}</div></>}
          </aside>
          <main className="reader"><div className="reader-top"><button className="icon-button small sidebar-toggle" onClick={() => setSidebarCollapsed(value => !value)} aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed ? t('显示页面侧栏', 'Show page sidebar') : t('收起页面侧栏', 'Hide page sidebar')} title={sidebarCollapsed ? t('显示页面侧栏', 'Show page sidebar') : t('收起页面侧栏', 'Hide page sidebar')}>{sidebarCollapsed ? <PanelLeftOpen size={16}/> : <PanelLeftClose size={16}/>}</button><span className="reader-breadcrumb"><FileText size={13}/><span title={currentPage.sourceName}>{pdfName(currentPage.sourceName)}</span><ChevronRight size={12}/><b>{t(`第 ${activeIndex + 1} 页`, `Page ${activeIndex + 1}`)}</b></span><button className={`tool-button ${selectText&&!editorOpen&&!markOpen&&!originalOpen?'active':''}`} aria-pressed={selectText&&!editorOpen&&!markOpen&&!originalOpen} disabled={!!busy} title={t('鼠标拖选原 PDF 文字，Ctrl+C 复制','Drag to select PDF text; Ctrl+C copies')} onClick={()=>{setEditorOpen(false);setTextDrawMode(false);setOriginalOpen(false);setMarkOpen(false);setSelectText(value=>editorOpen||markOpen||originalOpen?true:!value);}}><Copy size={14}/><span>{t('选字','Select text')}</span></button><button className={`tool-button ${textDrawMode?'active':''}`} aria-pressed={textDrawMode} disabled={!!busy} onClick={()=>{setOriginalOpen(false);setMarkOpen(false);setEditorOpen(true);setTextDrawMode(value=>!value);}}><PenLine size={14}/><span>{t('文本框','Text box')}</span></button><span className="paper-dimensions">{Math.round(pageDimensions.width * 25.4 / 72)} × {Math.round(pageDimensions.height * 25.4 / 72)} mm</span></div>
            {markOpen && <MarkToolbar onStyleChange={styleMark} onEditPixels={() => void openPixelEdit(false)} settings={markSettings} onChange={setMarkSettings} selected={currentPage.overlays?.find(item => item.id === activeOverlayId)} disabled={!!busy} onClose={() => setMarkOpen(false)} onDuplicate={duplicateMark} onOpacity={opacity => updateOverlays((currentPage.overlays ?? []).map(item => item.id === activeOverlayId && !item.locked ? { ...item, opacity } : item))} onRemove={() => updateOverlays((currentPage.overlays ?? []).filter(item => item.id !== activeOverlayId || item.locked))}/>}
            <PdfViewer pinnedPageId={inlineEditing ? activeId : undefined} pages={pages} zoom={zoom} navigation={navigation} onZoom={setZoom} onSize={setViewerSize} interactionBlocked={!!busy || printOpen || inlineEditing} onActiveChange={id => { if (!busyRef.current) setActiveId(id); }} controls={(page, ready, loading, onPreview) => {
                const dimensions = visiblePageSize(page);
                return <>
                    {selectText && !editorOpen && !markOpen && !originalOpen && ready && <PageTextLayer key={`text-${page.id}`} page={page} disabled={!!busy || loading || printOpen}/>}
                    {editorOpen && textDrawMode && page.id === activeId && <TextToolLayer key={`text-draw-${page.id}`} source={textToolStyle} pageWidth={dimensions.width} pageHeight={dimensions.height} disabled={!!busy || !ready || loading}
                      onEditingChange={value=>{inlineEditingRef.current=value;setInlineEditing(value);}} onError={message=>notify(message,'error')} onCancel={()=>setTextDrawMode(false)}
                      onCommit={item=>{const target=live.current.pages.find(value=>value.id===page.id);if(!target)return false;const result=updatePageOverlays(page.id,[...(target.overlays??[]),item]);if(result!==false){setTextDrawMode(false);setActiveOverlayId(item.id);}return result;}}/>}
                    {(editorOpen || markOpen && markSettings.tool === 'select') && <OverlayHandles key={`overlay-${page.id}`} overlays={page.overlays ?? []} freeResize={markOpen} selectedId={page.id === activeId ? activeOverlayId : ''} onSelect={id => { setActiveId(page.id); setActiveOverlayId(id); }} pageWidth={dimensions.width} pageHeight={dimensions.height} onChange={(next, options) => updatePageOverlays(page.id, next, options)} onPreview={onPreview} onError={message => notify(message, 'error')} onEditingChange={value => { inlineEditingRef.current = value; setInlineEditing(value); }} disabled={!!busy || !ready || loading}/>}
                    {(editorOpen || markOpen && markSettings.tool === 'select') && page.id === activeId && (page.overlays ?? []).filter(item => item.id === activeOverlayId && item.markSource).map(item => <EditableMarkHandles key={`nodes-${item.id}`} item={item} pageWidth={dimensions.width} pageHeight={dimensions.height} onPreview={onPreview} onChange={next => updatePageOverlays(page.id, (page.overlays ?? []).map(value => value.id === next.id ? next : value))} disabled={!!busy || !ready || loading}/>)}
                    {markOpen && markSettings.tool !== 'select' && <MarkLayer key={`mark-${page.id}`} settings={markSettings} pageWidth={dimensions.width} pageHeight={dimensions.height} disabled={!!busy || !ready || loading} onBegin={() => { setActiveId(page.id); setActiveOverlayId(''); }} onComplete={(mark, settings) => void addDrawnMark(page.id, mark, settings)}/>}
                    {originalOpen && page.id === currentPage.id && <OriginalContentHandles key={currentPage.id} page={currentPage} rendering={loading} eraseMode={originalEraseMode} objects={visibleOriginal?.objects ?? []} contentEdits={currentPage.contentEdits ?? []} selectedId={originalSelected} onSelect={setOriginalSelected} onChange={updateContentEdits} pageWidth={dimensions.width} pageHeight={dimensions.height} inspectionKey={originalPlanKey} disabled={!!busy || !ready || loading || originalLoading || !visibleOriginal}/>}
                </>;
            }}/>
            <div className="reader-bottom"><div className="page-navigation"><button className="icon-button small" disabled={activeIndex === 0} onClick={() => goToPage(activeIndex - 1)} aria-label={t("上一页")} title={t("上一页 \u00B7 \u2190")}><ChevronLeft size={17}/></button><input aria-label={t("页码")} inputMode="numeric" value={pageInput} onChange={(event) => setPageInput(event.target.value)} onBlur={applyPageInput} onKeyDown={(event) => { if (event.key === 'Enter') {
            applyPageInput();
            event.currentTarget.blur();
        } }}/><span>/ {pages.length}</span><button className="icon-button small" disabled={activeIndex === pages.length - 1} onClick={() => goToPage(activeIndex + 1)} aria-label={t("下一页")} title={t("下一页 \u00B7 \u2192")}><ChevronRight size={17}/></button></div><div className="zoom-controls"><button className="icon-button small" aria-label={t("缩小")} title={t("缩小 \u00B7 Ctrl+-")} onClick={() => changeZoom(-10)} disabled={zoomPercent <= 25}><Minus size={16}/></button><button className="zoom-label" onClick={() => setZoom(100)} title={t("恢复 100%")}>{zoomPercent}%</button><button className="icon-button small" aria-label={t("放大")} title={t("放大 \u00B7 Ctrl++")} onClick={() => changeZoom(10)} disabled={zoomPercent >= 400}><Plus size={16}/></button><span className="toolbar-divider"/><button className={`fit-button ${zoom === 'fit' ? 'active' : ''}`} onClick={() => setZoom('fit')} title={t("适合宽度 \u00B7 Ctrl+0")}><Maximize2 size={14}/><span>{t("适宽")}</span></button><button className={`fit-button ${zoom === 'page' ? 'active' : ''}`} onClick={() => setZoom('page')} title={t('适合整页 · Ctrl+1', 'Fit whole page · Ctrl+1')}><FileText size={14}/><span>{t('整页', 'Page')}</span></button></div></div>
          </main>
        </div>
        <footer className="status-bar"><span><ShieldCheck size={12}/>{t("本地处理")}<span className="footer-dot">·</span>{sizeLabel(totalBytes)}<span className="footer-dot">·</span>{busy ? <><LoaderCircle size={12} className="spin"/>{busy}</> : dirty ? t("修改尚未保存") : t("就绪")}</span><span>{selection.size ? t(`${selection.size} 页已选中`) : t("R 旋转 \u00B7 Delete 删除 \u00B7 Ctrl+S 保存副本")}</span></footer>
      </>}
    </div>

    {/* OVERLAY_EDITOR_INTEGRATION: root mounts OverlayEditor with currentPage, pageDimensions and immutable commit here. */}
    {draggingFile && <div className="file-drop-overlay"><div><div className="drop-overlay-icon"><Upload size={32}/></div><h2>{pages.length ? t("松开\uFF0C添加到当前文档") : t("松开\uFF0C打开你的 PDF")}</h2><p>{pages.length ? t("新页面将添加在文档末尾") : t("支持同时打开多份 PDF\uFF0C按顺序合并")}</p></div></div>}
    {busy && <div className="busy-pill" role="status"><LoaderCircle size={16} className="spin"/>{busy}</div>}
    <div className="toast-stack" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast ${toast.tone}`}>{toast.tone === 'success' ? <Check size={17}/> : toast.tone === 'error' ? <CircleAlert size={17}/> : <FileText size={17}/>}<span>{t(toast.message)}</span><button aria-label={t("关闭提示")} onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}><X size={14}/></button></div>)}</div>
    {importRequest && <div className="modal-backdrop"><form className="modal import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title" onSubmit={event => { event.preventDefault(); void submitImport(); }}>
        <button type="button" className="icon-button modal-close" onClick={() => { setImportRequest(null); setImportError(''); }} aria-label={t('取消导入', 'Cancel import')}><X size={18}/></button>
        <div className="modal-symbol"><FilePlus2 size={25}/></div><h2 id="import-title">{t('导入与合并 PDF', 'Import and merge PDFs')}</h2>
        <p className="modal-description">{t(`已选择 ${importRequest.paths.length} 份 PDF。选择来源页码和插入位置；保存副本后得到合并文件。`, `${importRequest.paths.length} PDFs selected. Choose their source pages and an insertion point, then save a copy to create the merged PDF.`)}</p>
        <label className="field-label" htmlFor="import-range">{t('来源页码范围（留空为全部）', 'Source page range (leave empty for all)')}</label>
        <input id="import-range" className="text-input" value={importRequest.range} placeholder="1-3,5" onChange={event => { setImportRequest({ ...importRequest, range: event.target.value }); setImportError(''); }}/>
        <p className="field-hint">{t('同一范围应用到每份来源 PDF，按各文件原有页序导入。', 'The same range applies to each source PDF, retaining its page order.')}</p>
        <label className="field-label" htmlFor="import-position">{t('插入位置', 'Insertion point')}</label>
        <select id="import-position" className="text-input" value={importRequest.position} onChange={event => setImportRequest({ ...importRequest, position: event.target.value as ImportRequest['position'] })}>
            <option value="after">{t(`当前第 ${activeIndex + 1} 页之后`, `After the current page (${activeIndex + 1})`)}</option>
            <option value="end">{t('文档末尾', 'End of document')}</option><option value="before">{t('指定页之前', 'Before a specific page')}</option>
        </select>
        {importRequest.position === 'before' && <label className="import-target-label">{t('插入到第几页之前', 'Insert before page')}<input className="text-input" inputMode="numeric" value={importRequest.targetPage} onChange={event => setImportRequest({ ...importRequest, targetPage: event.target.value })}/></label>}
        {importError && <p className="form-error" role="alert">{importError}</p>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => { setImportRequest(null); setImportError(''); }}>{t('取消', 'Cancel')}</button><button type="submit" className="button primary">{t('导入页面', 'Import pages')}<ChevronRight size={15}/></button></div>
    </form></div>}
    {closeRequest && !exportRequest && !busy && !closingRef.current && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="close-title"><div className="modal-symbol"><Save size={26}/></div><h2 id="close-title">{closeRequest === 'document' ? t('关闭 PDF 前保存修改？', 'Save changes before closing this PDF?') : t('退出前保存这次修改？', 'Save changes before quitting?')}</h2><p className="modal-description">{t('保存项目可保留文字、折点和源 PDF，方便继续编辑；保存 PDF 副本会将新增内容输出为图像。', 'Save a project to retain editable text, path nodes and source PDFs. Saving a PDF copy exports added content as images.')}</p><div className="replace-actions"><button className="button primary" disabled={!!busy} onClick={async () => { const action = closeRequest; if (await saveProject()) { if (action === "document") await closeCurrentDocument(); else await closeApplication(); } }}>{t("保存项目后关闭", "Save project and close")}</button><button className="button secondary" onClick={async () => { const action = closeRequest; if (await saveCopy()) { if (action === 'document') await closeCurrentDocument(); else await closeApplication(); } }} disabled={!!busy}>{closeRequest === 'document' ? t('保存副本并关闭', 'Save copy and close') : t('保存副本并退出', 'Save copy and quit')}</button><button className="button secondary" onClick={() => void (closeRequest === 'document' ? closeCurrentDocument() : closeApplication())} disabled={!!busy}>{closeRequest === 'document' ? t('不保存，关闭 PDF', 'Close PDF without saving') : t('不保存，退出', 'Quit without saving')}</button><button className="text-button" onClick={() => setCloseRequest(null)} disabled={!!busy}>{t('继续编辑', 'Keep editing')}</button></div></div></div>}
    {editorOpen && currentPage && <OverlayEditor drawingText={textDrawMode} onDrawText={()=>setTextDrawMode(value=>!value)} onTextStyleChange={setTextToolStyle} key={currentPage.id} pageWidth={pageDimensions.width} pageHeight={pageDimensions.height} overlays={currentPage.overlays ?? []} selectedId={activeOverlayId} onSelect={setActiveOverlayId} onChange={updateOverlays} disabled={!!busy && !editorBusyRef.current} onError={message => notify(message, 'error')} onClose={() => { if (!busyRef.current) setEditorOpen(false); setTextDrawMode(false); }} onBusyChange={editorBusyChanged}/>}
    {originalOpen && currentPage && <OriginalContentEditor key={currentPage.id} onRasterEdit={() => void openPixelEdit(true)} eraseMode={originalEraseMode} onEraseMode={setOriginalEraseMode} page={pageReference(currentPage)} pageWidth={pageDimensions.width} pageHeight={pageDimensions.height} objects={visibleOriginal?.objects ?? []} contentEdits={currentPage.contentEdits ?? []} selectedId={originalSelected} onSelect={setOriginalSelected} onChange={updateContentEdits} loading={originalLoading} error={originalError} warnings={visibleOriginal?.warnings ?? []} totalObjects={visibleOriginal?.totalObjects ?? 0} truncated={visibleOriginal?.truncated ?? false} inspectionKey={originalPlanKey} onRefresh={() => { originalInspectionRef.current = null; setOriginalRefresh(value => value + 1); }} onClose={() => { if (!busyRef.current) setOriginalOpen(false); }} onBusyChange={originalBusyChanged} onError={message => notify(message, 'error')} disabled={!!busy && !originalBusyRef.current} onEditLines={() => setLineOpen(true)}/>}
    {pixelEdit && <ImageEditDialog image={pixelEdit.image} title={pixelEdit.overlayId?t('选中标记或图章','Selected mark or stamp'):t('当前页像素编辑','Current page pixels')} notice={pixelEdit.overlayId?undefined:t('应用后仅将当前页转换为图像。该页文字不再可搜索，链接、可编辑对象及批注结构不保留；其他页不变，可撤销恢复。','Applying converts only this page to an image. Its searchable text, links, editable objects and annotation structure are not retained. Other pages stay unchanged; undo restores the page.')} applyLabel={pixelEdit.overlayId?undefined:t('转换本页并应用','Convert this page and apply')} onApply={applyPixelEdit} onClose={()=>setPixelEdit(null)} onBusyChange={documentToolsBusy}/>} 
    {pageToolsOpen && <DeferredDialog onCancel={() => setPageToolsOpen(false)}><PageToolsDialog pages={pages} activeIndex={activeIndex} selectedIds={selection} title={title} onClose={() => setPageToolsOpen(false)} onBusyChange={documentToolsBusy} onPlan={next => { commit(next); setPageToolsOpen(false); notify(t('页面方案已更新，可撤销。', 'Page plan updated. You can undo it.'), 'success'); }} onGenerated={addGeneratedPages} onExport={parts => { setPageToolsOpen(false); void requestExport(parts); }}/></DeferredDialog>}
    {lineOpen && currentPage && <DeferredDialog onCancel={() => setLineOpen(false)}><TextLineEditor page={currentPage} objects={visibleOriginal?.objects ?? []} loading={originalLoading || !visibleOriginal} onClose={() => setLineOpen(false)} onBusyChange={documentToolsBusy} onApplied={document => addGeneratedPages(document, [currentPage.id], 0)}/></DeferredDialog>}
    {exportRequest && <DeferredDialog onCancel={cancelExport}><ExportDialog parts={exportRequest.parts} onClose={cancelExport} onSaved={finishedExport} onBusyChange={documentToolsBusy}/></DeferredDialog>}
    {printOpen && pages.length > 0 && <DeferredDialog onCancel={() => setPrintOpen(false)}><PrintDialog pages={pages} activeIndex={activeIndex} selectedIds={selection} title={title} onClose={() => { if (!busyRef.current) setPrintOpen(false); }} onBusyChange={printingBusyChanged} onNotify={notify}/></DeferredDialog>}
    {settingsOpen && <WindowsSettingsDialog onClose={() => setSettingsOpen(false)} onShortcuts={() => { setSettingsOpen(false); setShowShortcuts(true); }}/>} 
    {passwordRequest && <PasswordDialog request={passwordRequest} onAnswer={answerPassword}/>}
    {replaceRequest && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="replace-title"><div className="modal-symbol"><FileText size={26}/></div><h2 id="replace-title">{t("先保留这次修改\uFF1F")}</h2><p className="modal-description">{t("当前文档有未保存的页面调整\u3002打开新的文档前\uFF0C可以先将它保存为副本\u3002")}</p><div className="replace-actions"><button className="button primary" disabled={!!busy} onClick={async () => { const paths = replaceRequest; if (await saveProject()) { setReplaceRequest(null); void loadPaths(paths, false); } }}>{t("保存项目并打开", "Save project and open")}</button><button className="button secondary" onClick={async () => { const paths = replaceRequest; if (await saveCopy()) {
        setReplaceRequest(null);
        void loadPaths(paths, false);
    } }} disabled={!!busy}>{t("保存副本并打开")}</button><button className="button secondary" onClick={() => { const paths = replaceRequest; setReplaceRequest(null); void loadPaths(paths, false); }} disabled={!!busy}>{t("不保存\uFF0C继续打开")}</button><button className="text-button" onClick={() => setReplaceRequest(null)}>{t("返回文档")}</button></div></div></div>}
    {showShortcuts && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget)
        setShowShortcuts(false); }}><div className="modal shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title"><button className="icon-button modal-close" aria-label={t("关闭快捷键")} onClick={() => setShowShortcuts(false)}><X size={18}/></button><div className="modal-symbol"><Keyboard size={26}/></div><h2 id="shortcuts-title">{t("让操作更顺手")}</h2><p className="modal-description">{t("几个熟悉的按键\uFF0C让整理文档更从容\u3002")}</p><div className="shortcut-list"><div><kbd>Ctrl + W</kbd><span>{t("关闭当前 PDF", "Close current PDF")}</span></div>{[[t("打开 PDF"), 'Ctrl + O'], [t("添加 PDF"), 'Ctrl + Shift + O'], [t("保存副本"), 'Ctrl + S'], [t("保存可编辑项目", "Save editable project"), 'Ctrl + Shift + S'], [t("打印与预览", "Print and preview"), 'Ctrl + P'], [t("查找文字"), 'Ctrl + F'], [t("撤销 / 重做"), 'Ctrl + Z / Ctrl + Shift + Z'], [t("选择全部页面"), 'Ctrl + A'], [t("旋转 / 删除页面"), 'R / Delete'], [t("前移 / 后移页面"), 'Alt + ↑ / Alt + ↓'], [t("上一页 / 下一页"), '← / →'], [t("放大 / 缩小"), 'Ctrl + + / Ctrl + −'], [t("适合宽度"), 'Ctrl + 0'], [t('适合整页', 'Fit whole page'), 'Ctrl + 1'], [t('鼠标位置缩放', 'Zoom at pointer'), t('Ctrl + 滚轮', 'Ctrl + wheel')], [t('连续阅读', 'Continuous reading'), t('滚轮 / 空格', 'Wheel / Space')]].map(([label, key]) => <div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</div><p className="shortcut-footnote">{t("按住 Ctrl 点击缩略图可多选\uFF0C按住 Shift 可连续选择\u3002")}</p></div></div>}
    {showWarnings && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget)
        setShowWarnings(false); }}><div className="modal warnings-modal" role="dialog" aria-modal="true" aria-labelledby="warnings-title"><button className="icon-button modal-close" aria-label={t("关闭文档提示")} onClick={() => setShowWarnings(false)}><X size={18}/></button><div className="modal-symbol amber"><CircleAlert size={26}/></div><h2 id="warnings-title">{t("文档处理提示")}</h2><p className="modal-description">{t("保存副本前\uFF0C请确认这些提示符合你的使用需求\u3002")}</p><div className="warnings-list">{warnings.map((warning, index) => <div key={index}><strong>{warning.source}</strong><p>{t(warning.message)}</p></div>)}</div><button className="button primary" onClick={() => setShowWarnings(false)}>{t("我知道了")}</button></div></div>}
  </div>;
}

export default function App() { return <I18nProvider><AppWorkspace /></I18nProvider>; }
