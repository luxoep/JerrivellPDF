# SPDX-License-Identifier: MIT OR Apache-2.0
"""Real-React annotation interaction regression in an isolated headless browser.

Uses the production controls/geometry/asset queue with a synthetic PDF backdrop
and a fake native image registrar. Never attaches to an app or user browser.
Development-only: existing Python Playwright + existing Chrome/Edge + Vite.
Generated fixtures, reports and screenshots stay under test-results.
"""
from pathlib import Path
import argparse, hashlib, json, os, socket, subprocess, sys, time, traceback, urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT/'package.json').read_text(encoding='utf-8'))['version']
TOOL_DIR = ROOT / 'test-results/0.8.3/browser-tools'
if TOOL_DIR.is_dir():
    sys.path.insert(0, str(TOOL_DIR))
from playwright.sync_api import sync_playwright

HARNESS = r'''
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '/src/i18n';
import { OverlayHandles } from '/src/components/OverlayHandles';
import { LivePageImage } from '/src/components/LivePageImage';
import { MarkLayer } from '/src/components/MarkLayer';
import { EditableMarkHandles } from '/src/components/EditableMarkHandles';
import { createMarkGeometry, createMarkPng } from '/src/markGeometry';
import { renderTextFrame } from '/src/textFrame';
import { prepareEditableOverlays, attachLeader } from '/src/editableOverlays';
import { duplicatedOverlay, rotatedOverlay90 } from '/src/overlayGeometry';
import { stageImageAsset } from '/src/backend';
import '/src/components/reader-experience.css';
import type { PageOverlay } from '/src/types';
import type { OverlayChangeOptions } from '/src/editableOverlays';

declare global { interface Window { harness: any; stats: any; __TAURI_INTERNALS__: any; } }
const stats = window.stats = { encodes: 0, nativeCalls: 0, commands: [] as string[], commits: 0, previews: 0, editingActive: false, editingTransitions: [] as boolean[], leakedFixedKeys: 0 };
const fixedKeyEvents: KeyboardEvent[] = [];
window.addEventListener('keydown', event => { if ((event.target as HTMLElement)?.closest?.('.editable-mark-node.fixed')) fixedKeyEvents.push(event); }, true);
window.addEventListener('keydown', event => { if ((event.target as HTMLElement)?.closest?.('.editable-mark-node.fixed') && ['Delete','Backspace','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) stats.leakedFixedKeys++; });
const encode = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function(...args: Parameters<typeof encode>) { stats.encodes++; return encode.apply(this,args); };
let assetId = 0;
window.__TAURI_INTERNALS__ = { async invoke(command: string, args: any) {
  stats.nativeCalls++; stats.commands.push(command);
  if (command !== 'register_image') throw Error(`Unexpected native command: ${command}`);
  const image = new Image(); image.src = args.dataUrl; await image.decode();
  return { id: `synthetic-native-${++assetId}`, dataUrl: args.dataUrl, width: image.naturalWidth, height: image.naturalHeight };
} };
const PAGE_WIDTH = 600, PAGE_HEIGHT = 800;
const background = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="white"/><g fill="none" stroke="#d9e1e5" stroke-width="1"><path d="M30 100H570M30 200H570M30 300H570M30 400H570M30 500H570M30 600H570M30 700H570"/></g><text x="30" y="48" fill="#6e8794" font-family="sans-serif" font-size="18">Synthetic annotation interaction fixture</text></svg>');
const layers = { background: { dataUrl: background, width: 600, height: 800 }, foreground: [] };
const flush = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const textContent = 'Flexible text frames keep their font size while wrapping words and 中文内容 into additional lines.';
const style = { tool: 'polyarrow' as const, color: '#284c64', opacity: 1, lineWidth: 2, lineStyle: 'dashDot' as const, arrowHeads: 'end' as const };

function App() {
  const [overlays, setOverlays] = useState<PageOverlay[]>([]), [placement, setPlacement] = useState<PageOverlay | null>(null);
  const [selected, setSelected] = useState(''), [mode, setMode] = useState('text'), [errors, setErrors] = useState<string[]>([]), [generation, setGeneration] = useState(0);
  const current = useRef({ overlays, selected, placement, mode }); current.current = { overlays, selected, placement, mode };
  const fail = (message: string) => setErrors(previous => [...previous, message]);
  const apply = (requested: PageOverlay[], options?: OverlayChangeOptions) => {
    if (JSON.stringify(requested) === JSON.stringify(current.current.overlays)) return;
    try {
      const prepared = prepareEditableOverlays(current.current.overlays, requested, PAGE_WIDTH, PAGE_HEIGHT, options);
      const assets = new Map(prepared.images.map(image => [image.id, stageImageAsset(image.dataUrl)]));
      const next = prepared.overlays.map(item => assets.has(item.id) ? { ...item, assetId: assets.get(item.id)!.id } : item);
      for (const asset of assets.values()) void asset.registered.catch(error => fail(String(error)));
      stats.commits++; setOverlays(next);
    } catch (error) { fail(String(error)); }
  };
  const preview = (item: PageOverlay | null) => { stats.previews++; setPlacement(item); };
  window.harness = {
    async scenario(name: string) {
      const pending: Promise<unknown>[] = [], next: PageOverlay[] = [];
      const addRaster = (item: PageOverlay, dataUrl: string) => {
        const asset = stageImageAsset(dataUrl); pending.push(asset.registered); next.push({ ...item, assetId: asset.id });
      };
      if (name.startsWith('text') || name.startsWith('leader')) {
        const isLeader = name.startsWith('leader'), autoHeight = name === 'text-auto';
        const item: PageOverlay = { id: 'text', assetId: '', x: isLeader ? .6 : .2, y: isLeader ? .15 : .2,
          width: (isLeader ? 200 : 300) / PAGE_WIDTH, height: (isLeader ? 100 : 220) / PAGE_HEIGHT, opacity: 1, rotation: 0,
          textSource: { content: isLeader ? 'Linked annotation' : textContent, color: '#243f50', fontSize: 12, bold: false, fontFamily: 'Arial',
            frame: { width: isLeader ? 200 : 300, height: isLeader ? 100 : 220, autoHeight } } };
        const result = renderTextFrame(item, PAGE_WIDTH, PAGE_HEIGHT); addRaster(result.overlay, result.dataUrl);
        if (isLeader) {
          const geometry = createMarkGeometry([{ x: .15, y: .75 }, { x: .45, y: .2125 }, { x: .6, y: .2125 }], { ...style, tool: 'callout', arrowHeads: 'start' }, PAGE_WIDTH, PAGE_HEIGHT)!;
          const leader = attachLeader({ id: 'leader', assetId: '', ...geometry.bounds, opacity: 1, rotation: 0, leaderFor: 'text', markSource: { geometry, color: style.color } }, result.overlay);
          addRaster(leader, createMarkPng(leader.markSource!.geometry, style.color));
        }
      } else if (name === 'nodes') {
        const geometry = createMarkGeometry([{ x: .15, y: .65 }, { x: .45, y: .35 }, { x: .75, y: .35 }], style, PAGE_WIDTH, PAGE_HEIGHT)!;
        addRaster({ id: 'mark', assetId: '', ...geometry.bounds, opacity: 1, rotation: 0, markSource: { geometry, color: style.color } }, createMarkPng(geometry, style.color));
      }
      setPlacement(null); setErrors([]); setOverlays(next); setSelected(name === 'nodes' ? 'mark' : name === 'leader-nodes' ? 'leader' : next.length ? 'text' : ''); setMode(name === 'nodes' || name === 'leader-nodes' ? 'nodes' : name === 'draw' ? 'draw' : 'text');setGeneration(value=>value+1);
      await Promise.all(pending); await flush();
      stats.encodes = stats.nativeCalls = stats.commits = stats.previews = stats.leakedFixedKeys = 0; stats.commands = [];stats.editingActive=false;stats.editingTransitions=[];fixedKeyEvents.length=0;
      const bg = document.querySelector('[data-pdf-background]'); (window as any).backgroundSentinel = bg;
      return this.snapshot();
    },
    rotateSelected() { const state=current.current;apply(state.overlays.map(item=>item.id===state.selected?rotatedOverlay90(item,PAGE_WIDTH,PAGE_HEIGHT):item)); },
    duplicateSelected() { const state=current.current,item=state.overlays.find(item=>item.id===state.selected)!;const copy=duplicatedOverlay(item,`${item.id}-copy`,PAGE_WIDTH,PAGE_HEIGHT);apply([...state.overlays,copy]);setSelected(copy.id); },
    snapshot() {
      const preview = current.current.placement;
      return { overlays: current.current.overlays, placement: preview, selected: current.current.selected, mode: current.current.mode,
        stats: { ...stats }, fixedKeyEvents: fixedKeyEvents.map(event=>({key:event.key,defaultPrevented:event.defaultPrevented})), errors: [...document.querySelectorAll('#errors [role="alert"]')].map(node => node.textContent),
        backgroundHref: document.querySelector('[data-pdf-background]')?.getAttribute('href'),
        sameBackgroundNode: document.querySelector('[data-pdf-background]') === (window as any).backgroundSentinel,
        liveLines: [...document.querySelectorAll('[data-text-frame-preview] text')].map(node => node.textContent),
        liveFontSize: document.querySelector('[data-text-frame-preview] [font-size]')?.getAttribute('font-size'),
        livePaths: [...document.querySelectorAll('[data-live-overlay="leader"] polyline')].map(node => node.getAttribute('points')) };
    }
  };
  const page = { id: 'synthetic-page', documentId: 'synthetic-source', pageIndex: 0, rotation: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, sourceName: 'Synthetic fixture.pdf', overlays };
  return <><header><b>Real React annotation controls</b><span>Synthetic fixture · no native PDF operations</span></header><div id="sheet" className="pdf-sheet">
    <LivePageImage page={page} layers={layers} placement={placement} label="Synthetic PDF page"/>
    {mode !== 'draw' && <OverlayHandles key={generation} overlays={overlays} selectedId={selected} onSelect={setSelected} pageWidth={PAGE_WIDTH} pageHeight={PAGE_HEIGHT} onChange={apply} onPreview={preview} onError={fail} onEditingChange={active=>{stats.editingActive=active;stats.editingTransitions.push(active);}}/>}
    {mode === 'draw' && <MarkLayer key={generation} settings={style} pageWidth={PAGE_WIDTH} pageHeight={PAGE_HEIGHT} disabled={false} onBegin={() => setSelected('')} onComplete={(geometry, settings) => {
      const item = { id: `drawn-${current.current.overlays.length + 1}`, assetId: '', ...geometry.bounds, opacity: settings.opacity, rotation: 0, markSource: { geometry, color: settings.color } };
      apply([...current.current.overlays, item]);
    }}/>}
    {mode === 'nodes' && overlays.find(item => item.id === selected)?.markSource && <EditableMarkHandles key={generation+'-'+selected} item={overlays.find(item => item.id === selected)!} pageWidth={PAGE_WIDTH} pageHeight={PAGE_HEIGHT} onPreview={preview} onChange={item => apply(overlays.map(value => value.id === item.id ? item : value))}/>}
  </div><aside><p>Drag handles, draw paths, edit nodes and linked labels.</p><div id="errors">{errors.map((error,index) => <p key={index} role="alert">{error}</p>)}</div></aside></>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><App/></I18nProvider>);
'''

HTML = '''<!doctype html><html><head><meta charset="utf-8"><title>Annotation interaction regression</title><style>
*{box-sizing:border-box}body{margin:0;background:#e8edf0;color:#243f50;font:14px Arial,sans-serif}header{height:50px;padding:16px 40px;display:flex;gap:20px}header span{color:#687f8c}#sheet{position:relative;width:600px;height:800px;margin:10px 0 30px 40px;background:#fff;box-shadow:0 2px 20px #35516425}aside{position:absolute;left:690px;top:70px;width:430px;padding:20px;background:#fff;border-radius:8px}#errors{color:#a43827}button{font:inherit}
</style></head><body><div id="root"></div><script type="module" src="./annotation-harness.tsx"></script></body></html>'''

SOURCES = ['src/components/OverlayHandles.tsx','src/components/LivePageImage.tsx','src/components/MarkLayer.tsx',
           'src/components/EditableMarkHandles.tsx','src/components/overlayCanvas.ts','src/textFrame.ts',
           'src/placementGeometry.ts','src/editableOverlays.ts','src/markGeometry.ts','src/backend.ts',
           'src/overlayGeometry.ts','src/viewerGeometry.ts','src/types.ts',
           'src/components/overlay-handles.css','src/components/editable-mark-handles.css',
           'src/components/reader-experience.css','tests/editable-overlays-browser.py']

def snapshot(page):
    return page.evaluate('harness.snapshot()')

def scenario(page, name):
    return page.evaluate('(name)=>harness.scenario(name)',name)

def assert_backdrop(before, after):
    assert after['sameBackgroundNode'], 'The underlying PDF background element was replaced'
    assert after['backgroundHref'] == before['backgroundHref'], 'The underlying PDF raster changed'
    assert all(command == 'register_image' for command in after['stats']['commands']), 'A drag triggered PDF rendering'

def point(page, x, y):
    box=page.locator('#sheet').bounding_box()
    return box['x']+x*box['width'],box['y']+y*box['height']

def drag_start(page, locator, dx, dy, alt=False):
    box=locator.bounding_box();x=box['x']+box['width']/2;y=box['y']+box['height']/2
    if alt:page.keyboard.down('Alt')
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+dx,y+dy,steps=12);page.wait_for_timeout(60)
    return snapshot(page)

def drag_end(page, alt=False):
    page.mouse.up()
    if alt:page.keyboard.up('Alt')
    page.wait_for_timeout(80)
    return snapshot(page)

def no_drag_raster(before, mid):
    assert mid['stats']['encodes']==before['stats']['encodes'], 'Dragging encoded a PNG'
    assert mid['stats']['nativeCalls']==before['stats']['nativeCalls'], 'Dragging invoked the native backend'
    assert mid['stats']['commits']==before['stats']['commits'], 'Dragging created intermediate history snapshots'
    assert_backdrop(before,mid)

def text_handles(page):
    records=[]
    for direction,dx,dy in [('nw',-20,-20),('n',0,-20),('ne',20,-20),('e',20,0),('se',20,20),('s',0,20),('sw',-20,20),('w',-20,0)]:
        before=scenario(page,'text-large');assert page.locator('.overlay-resize-handle').count()==8
        mid=drag_start(page,page.locator('.handle-'+direction),dx,dy);no_drag_raster(before,mid)
        assert mid['placement']['textSource']['fontSize']==12 and mid['liveFontSize']=='12'
        after=drag_end(page);assert not after['errors'],after['errors'];assert after['stats']['commits']==1
        assert after['overlays'][0]['textSource']['fontSize']==12
        assert after['stats']['encodes']==1 and after['stats']['nativeCalls']<=1
        assert_backdrop(before,after);records.append({'direction':direction,'commits':after['stats']['commits'],'encodes':after['stats']['encodes'],'nativeCalls':after['stats']['nativeCalls']})
    before=scenario(page,'text-auto');oldHeight=before['overlays'][0]['height']
    mid=drag_start(page,page.locator('.handle-e'),-120,0);no_drag_raster(before,mid)
    assert mid['placement']['height']>oldHeight and len(mid['liveLines'])>2,'A narrower frame must wrap and grow at fixed font size'
    after=drag_end(page);assert after['overlays'][0]['height']>oldHeight;assert not after['errors']
    return {'handles':records,'wrappedLines':len(mid['liveLines']),'oldHeight':oldHeight,'newHeight':after['overlays'][0]['height']}

def text_overflow(page):
    before=scenario(page,'text-large')
    mid=drag_start(page,page.locator('.handle-s'),0,-205);no_drag_raster(before,mid)
    assert page.locator('.text-frame-warning').is_visible(),'Overflow needs a visible hint during the drag'
    after=drag_end(page)
    assert after['errors'],'Rejected overflow needs a visible explanation'
    assert after['stats']['commits']==after['stats']['encodes']==after['stats']['nativeCalls']==0
    assert after['overlays']==before['overlays'],'Overflow must preserve the complete previous object'
    return {'visibleHint':True,'rejected':True,'errors':after['errors']}

def inline_edit(page):
    before=scenario(page,'text-large');handle=page.locator('.overlay-placement-handle').first
    handle.dblclick(position={'x':40,'y':40});field=page.get_by_role('textbox',name='直接编辑文字');field.wait_for()
    field.fill('Edited directly on the page. 中文内容');field.press('Control+Enter');page.wait_for_timeout(100)
    after=snapshot(page);assert after['overlays'][0]['textSource']['content']=='Edited directly on the page. 中文内容'
    assert after['stats']['commits']==1 and after['overlays'][0]['textSource']['fontSize']==12
    handle.dblclick(position={'x':40,'y':40});field=page.get_by_role('textbox',name='直接编辑文字');field.fill('Canceled change');field.press('Escape');page.wait_for_timeout(60)
    canceled=snapshot(page);assert canceled['overlays']==after['overlays'] and canceled['stats']['commits']==1
    assert_backdrop(before,canceled);return {'content':after['overlays'][0]['textSource']['content'],'commits':after['stats']['commits'],'escapePreserved':True}

def inline_overflow_draft(page):
    before=scenario(page,'text-large');page.locator('.overlay-placement-handle').first.dblclick(position={'x':40,'y':40})
    field=page.get_by_role('textbox',name='直接编辑文字');draft='Retained draft 中文 '.join(['More text']*35)
    field.fill(draft);assert snapshot(page)['stats']['editingActive'],'An inline editor must report its pending state to the close guard'
    field.press('Control+Enter');page.wait_for_timeout(80);rejected=snapshot(page)
    assert field.is_visible() and field.input_value()==draft,'Overflow must preserve the complete editable draft'
    assert rejected['errors'] and rejected['overlays']==before['overlays']
    assert rejected['stats']['commits']==rejected['stats']['encodes']==rejected['stats']['nativeCalls']==0
    assert rejected['stats']['editingActive'],'Rejected overflow must keep the close guard active'
    page.get_by_role('button',name='自动加高并完成',exact=True).click();page.wait_for_timeout(100);after=snapshot(page)
    assert page.get_by_role('textbox',name='直接编辑文字').count()==0
    assert after['overlays'][0]['textSource']['content']==draft and after['overlays'][0]['textSource']['fontSize']==12
    assert after['overlays'][0]['textSource']['frame']['autoHeight'] is True and after['overlays'][0]['height']>before['overlays'][0]['height']
    assert after['stats']['commits']==1 and after['stats']['editingTransitions']==[True,False] and not after['stats']['editingActive']
    assert_backdrop(before,after);return {'draftLength':len(draft),'overflowRetained':True,'autoHeightFinished':True,'editingTransitions':after['stats']['editingTransitions']}

def polyline_keys(page):
    before=scenario(page,'draw')
    for x,y in [(.2,.7),(.5,.4),(.75,.4)]:page.mouse.click(*point(page,x,y))
    page.keyboard.press('Enter');page.wait_for_timeout(80);after=snapshot(page)
    assert len(after['overlays'])==1 and len(after['overlays'][0]['markSource']['geometry']['points'])==3
    assert after['overlays'][0]['markSource']['geometry']['tool']=='polyarrow';assert_backdrop(before,after)
    scenario(page,'draw')
    for x,y in [(.2,.7),(.5,.4),(.75,.4)]:page.mouse.click(*point(page,x,y))
    page.keyboard.press('Backspace');page.keyboard.press('Enter');page.wait_for_timeout(80);reduced=snapshot(page)
    assert len(reduced['overlays'][0]['markSource']['geometry']['points'])==2
    scenario(page,'draw');page.mouse.click(*point(page,.2,.7));page.mouse.click(*point(page,.5,.4));page.keyboard.press('Escape');page.keyboard.press('Enter');page.wait_for_timeout(60);cancel=snapshot(page)
    assert not cancel['overlays'] and cancel['stats']['commits']==cancel['stats']['encodes']==cancel['stats']['nativeCalls']==0
    assert page.locator('.mark-preview').count()==0
    return {'enterPoints':3,'backspacePoints':2,'escapeCanceled':True}

def nodes(page):
    before=scenario(page,'nodes');middle=page.get_by_role('button',name='折线节点 2',exact=True)
    mid=drag_start(page,middle,30,15);no_drag_raster(before,mid);after=drag_end(page)
    old=before['overlays'][0]['markSource']['geometry']['points'][1];new=after['overlays'][0]['markSource']['geometry']['points'][1]
    assert abs(new['x']-old['x']-.05)<.002 and abs(new['y']-old['y']-.01875)<.002
    points=after['overlays'][0]['markSource']['geometry']['points'];a,b=points[:2]
    page.mouse.dblclick(*point(page,(a['x']+b['x'])/2,(a['y']+b['y'])/2));page.wait_for_timeout(80);inserted=snapshot(page)
    assert len(inserted['overlays'][0]['markSource']['geometry']['points'])==4
    page.get_by_role('button',name='折线节点 2',exact=True).focus();page.keyboard.press('Delete');page.wait_for_timeout(60);removed=snapshot(page)
    assert len(removed['overlays'][0]['markSource']['geometry']['points'])==3
    assert_backdrop(before,removed);return {'movedPoint':new,'insertedPoints':4,'removedPoints':3,'commits':removed['stats']['commits']}

def fixed_leader_nodes(page):
    before=scenario(page,'leader-nodes');fixed=page.get_by_role('button',name='折线节点 3',exact=True);fixed.focus()
    for key in ['Delete','Backspace','ArrowLeft','ArrowRight','ArrowUp','ArrowDown']:page.keyboard.press(key)
    afterKeys=snapshot(page)
    assert afterKeys['overlays']==before['overlays'] and afterKeys['stats']['commits']==0
    assert len(afterKeys['fixedKeyEvents'])==6 and all(event['defaultPrevented'] for event in afterKeys['fixedKeyEvents']),'Fixed endpoint keys must be consumed'
    assert afterKeys['stats']['leakedFixedKeys']==0,'Fixed node keys must never reach page deletion or navigation shortcuts'
    elbow=page.get_by_role('button',name='折线节点 2',exact=True);original=before['overlays'][1]['markSource']['geometry']['points'][1]
    mid=drag_start(page,elbow,25,70);no_drag_raster(before,mid)
    previewPoint=mid['placement']['markSource']['geometry']['points'][1]
    assert abs(previewPoint['y']-original['y'])<1e-8,'The landing elbow must stay horizontal in the live preview'
    after=drag_end(page);committed=after['overlays'][1]['markSource']['geometry']['points'][1]
    assert abs(committed['y']-original['y'])<1e-8 and abs(committed['x']-previewPoint['x'])<1e-8
    assert_backdrop(before,after);return {'fixedKeysConsumed':afterKeys['fixedKeyEvents'],'landingY':committed['y'],'previewMatchesCommit':True}

def cancel_gestures(page):
    before=scenario(page,'text-large');mid=drag_start(page,page.locator('.overlay-placement-handle').first,35,20);no_drag_raster(before,mid)
    page.keyboard.press('Escape');after=drag_end(page)
    assert after['placement'] is None and after['overlays']==before['overlays'] and after['stats']['commits']==0
    before=scenario(page,'nodes');mid=drag_start(page,page.get_by_role('button',name='折线节点 2',exact=True),30,20);no_drag_raster(before,mid)
    page.keyboard.press('Escape');after=drag_end(page)
    assert after['placement'] is None and after['overlays']==before['overlays'] and after['stats']['commits']==0
    assert after['stats']['encodes']==after['stats']['nativeCalls']==0
    mid=drag_start(page,page.get_by_role('button',name='折线节点 2',exact=True),10,0);after=drag_end(page)
    assert after['stats']['commits']==1,'A canceled capture must not block the next gesture'
    return {'textMoveCanceled':True,'nodeMoveCanceled':True,'subsequentGestureWorks':True}

def rotate_duplicate_mark(page):
    before=scenario(page,'nodes');old=before['overlays'][0];page.evaluate('harness.rotateSelected()');page.wait_for_timeout(80);rotated=snapshot(page)
    item=rotated['overlays'][0];assert item['rotation']==0 and item['markSource']['geometry']['points']!=old['markSource']['geometry']['points']
    assert item['markSource']['geometry']['tool']=='polyarrow' and item['markSource']['geometry']['arrowHeads']=='end'
    page.evaluate('harness.duplicateSelected()');page.wait_for_timeout(80);copied=snapshot(page)
    assert len(copied['overlays'])==2 and copied['overlays'][0]==item
    duplicate=copied['overlays'][1];dx=duplicate['x']-item['x'];dy=duplicate['y']-item['y']
    for original,point_ in zip(item['markSource']['geometry']['points'],duplicate['markSource']['geometry']['points']):
        assert abs(point_['x']-original['x']-dx)<1e-8 and abs(point_['y']-original['y']-dy)<1e-8
    assert duplicate['rotation']==0 and duplicate['id']!=item['id'];assert_backdrop(before,copied)
    return {'rotationReencoded':True,'duplicateRetainsNodes':True,'commits':copied['stats']['commits']}

def linked_leader(page):
    before=scenario(page,'leader');text=page.locator('.overlay-placement-handle').first
    mid=drag_start(page,text,25,15);no_drag_raster(before,mid);after=drag_end(page)
    original=before['overlays'][1]['markSource']['geometry']['points'];moved=after['overlays'][1]['markSource']['geometry']['points']
    assert moved[0]==original[0],'Moving only the label must keep its target fixed'
    assert moved[-1]!=original[-1],'Moving the label must update its connected end'
    beforeAlt=after
    midAlt=drag_start(page,text,20,10,alt=True);no_drag_raster(beforeAlt,midAlt);afterAlt=drag_end(page,alt=True)
    new=afterAlt['overlays'][1]['markSource']['geometry']['points']
    dx=afterAlt['overlays'][0]['x']-beforeAlt['overlays'][0]['x'];dy=afterAlt['overlays'][0]['y']-beforeAlt['overlays'][0]['y']
    assert abs(dx)+abs(dy)>.005 and abs(new[0]['x']-moved[0]['x']-dx)<.002 and abs(new[0]['y']-moved[0]['y']-dy)<.002,('Alt-drag must translate target and label together',{'before':moved[0],'after':new[0],'textDelta':[dx,dy],'errors':afterAlt['errors']})
    liveTarget=[float(value) for value in midAlt['livePaths'][0].split()[0].split(',')]
    liveDx=midAlt['placement']['x']-beforeAlt['overlays'][0]['x'];liveDy=midAlt['placement']['y']-beforeAlt['overlays'][0]['y']
    assert abs(liveTarget[0]/600-moved[0]['x']-liveDx)<.002 and abs(liveTarget[1]/800-moved[0]['y']-liveDy)<.002,'Alt group movement must also preview without a release-time jump'
    assert_backdrop(before,afterAlt)
    return {'targetFixedOnLabelMove':True,'targetTranslatedWithAlt':True,'previewTranslatedWithAlt':True,'actualTextDelta':[dx,dy],'commits':afterAlt['stats']['commits']}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--browser',default=os.environ.get('JERRIVELL_TEST_BROWSER',r'C:\Program Files\Google\Chrome\Application\chrome.exe'));parser.add_argument('--output',default=f'test-results/{VERSION}/editable-overlays-browser.json');parser.add_argument('--dpr',type=float,nargs='+',default=[1,1.25]);args=parser.parse_args()
    folder=ROOT/f'test-results/{VERSION}';folder.mkdir(parents=True,exist_ok=True)
    (folder/'annotation-harness.html').write_text(HTML,encoding='utf-8');(folder/'annotation-harness.tsx').write_text(HARNESS,encoding='utf-8')
    report={'sourceSha256':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in SOURCES},'cases':[],'pageErrors':[]}
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    log=(folder/'annotation-vite.log').open('w',encoding='utf-8')
    server=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',str(port),'--strictPort'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        url=f'http://127.0.0.1:{port}/test-results/0.8.4/annotation-harness.html'
        for _ in range(100):
            try:
                urllib.request.urlopen(url,timeout=.3).close();break
            except Exception:time.sleep(.1)
        else:raise RuntimeError('Vite harness server did not start')
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=args.browser,headless=True,ignore_default_args=['--hide-scrollbars'],args=['--disable-features=OverlayScrollbar'])
            for dpr in args.dpr:
                context=browser.new_context(viewport={'width':1280,'height':1000},device_scale_factor=dpr);page=context.new_page()
                page.on('pageerror',lambda error:report['pageErrors'].append(str(error)))
                page.goto(url);page.wait_for_function('!!window.harness');page.evaluate('document.fonts.ready')
                for name,run in [('text-eight-handles-and-reflow',text_handles),('text-overflow-rejection',text_overflow),('inline-text-edit-and-cancel',inline_edit),('inline-overflow-draft-and-auto-height',inline_overflow_draft),('polyline-enter-backspace-escape',polyline_keys),('path-node-drag-insert-delete',nodes),('fixed-leader-node-keys-and-landing',fixed_leader_nodes),('gesture-escape-and-restart',cancel_gestures),('mark-rotate-and-duplicate',rotate_duplicate_mark),('linked-leader-label-and-group-move',linked_leader)]:
                    case={'name':name,'dpr':dpr}
                    try:case.update(status='PASS',result=run(page))
                    except Exception as error:case.update(status='FAIL',error=str(error),traceback=traceback.format_exc())
                    screenshot=folder/f'annotation-{name}-dpr-{dpr}.png';page.screenshot(path=str(screenshot));case['screenshot']=str(screenshot.relative_to(ROOT))
                    report['cases'].append(case);print(json.dumps({k:v for k,v in case.items() if k not in ['traceback','result']},ensure_ascii=False),flush=True)
                context.close()
            browser.close()
    except Exception as error:
        report['fatalError']=str(error);report['traceback']=traceback.format_exc()
    finally:
        server.terminate()
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:server.kill();server.wait(timeout=10)
        log.close()
    report['finalSourceSha256']={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in SOURCES}
    report['changedSources']=[name for name in SOURCES if report['sourceSha256'][name]!=report['finalSourceSha256'][name]]
    report['status']='FAIL' if report.get('fatalError') or report['pageErrors'] or report['changedSources'] or any(case['status']=='FAIL' for case in report['cases']) else 'PASS'
    output=ROOT/args.output;output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8');print('REPORT '+str(output)+' '+report['status'],flush=True)
    if report['status']!='PASS':sys.exit(1)

if __name__=='__main__':main()
