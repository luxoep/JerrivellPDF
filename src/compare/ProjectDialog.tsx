// SPDX-License-Identifier: MIT OR Apache-2.0
import {useRef,useState} from 'react';
import {useDialogFocus} from './useDialogFocus';

export type ProjectPrompt =
  | {kind:'missing'|'changed'|'password';side:'A'|'B';retry:boolean}
  | {kind:'overwrite'};

type Tr = (zh:string,en:string)=>string;
export function ProjectDialog({prompt,busy,tr,onCancel,onContinue}:{
  prompt:ProjectPrompt;busy:boolean;tr:Tr;onCancel:()=>void;onContinue:(password?:string)=>void;
}) {
  const root=useRef<HTMLFormElement>(null);
  const [password,setPassword]=useState('');
  useDialogFocus(root,true,onCancel);
  const side='side' in prompt?prompt.side:'';
  const title=prompt.kind==='overwrite' ? tr('覆盖已有对比项目？','Replace existing comparison project?')
    : prompt.kind==='password' ? tr(`输入图纸 ${side} 的密码`,`Enter drawing ${side} password`)
      : tr(`定位原始图纸 ${side}`,`Locate original drawing ${side}`);
  const explanation=prompt.kind==='overwrite' ? tr('所选文件已存在。确认用当前设置和复核记录替换它。','The selected file exists. Confirm replacement with the current settings and review notes.')
    : prompt.kind==='password' ? (prompt.retry?tr('密码不正确，请重试。','Incorrect password. Try again.') : tr('此 PDF 需要密码才能重新打开。密码不会写入项目文件。','This PDF needs a password to reopen. The password is not stored in the project file.'))
      : prompt.kind==='changed' ? tr(`图纸 ${side} 的内容已变化。请选择内容完全相同的原始 PDF。`,`Drawing ${side} no longer matches the saved project. Choose the original PDF with identical contents.`)
        : tr(`找不到图纸 ${side}。请选择移动后的原始 PDF。`,`Drawing ${side} could not be found. Choose the original PDF at its new location.`);
  return <div className="modal-backdrop">
    <form ref={root} className="modal compare-project-dialog" role="dialog" aria-modal="true" aria-labelledby="compare-project-title"
      onSubmit={event=>{event.preventDefault();if(!busy){onContinue(prompt.kind==='password'?password:undefined);if(prompt.kind==='password')setPassword('')}}}>
      <h2 id="compare-project-title">{title}</h2>
      <p>{explanation}</p>
      {prompt.kind==='password'&&<input autoFocus className="text-input" type="password" autoComplete="off" aria-label={tr('PDF 密码','PDF password')}
        disabled={busy} value={password} onChange={event=>setPassword(event.target.value)}/>}
      <div className="modal-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>{tr('取消','Cancel')}</button>
        <button type="submit" className="button primary" disabled={busy}>{prompt.kind==='overwrite'?tr('覆盖项目','Replace project'):
          prompt.kind==='password'?tr('打开项目','Open project'):tr('选择原始 PDF','Choose original PDF')}</button>
      </div>
    </form>
  </div>;
}
