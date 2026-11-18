// SPDX-License-Identifier: MIT OR Apache-2.0
import {useEffect} from 'react';
import type {RefObject} from 'react';
export function useDialogFocus(root:RefObject<HTMLElement|null>,active:boolean,onClose:()=>void){
  useEffect(()=>{if(!active)return;const el=root.current;if(!el)return;const previous=document.activeElement as HTMLElement|null;
    const controls=()=>Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]'));
    if(!el.contains(document.activeElement))controls()[0]?.focus();const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();onClose()}else if(e.key==='Tab'){const nodes=controls(),i=nodes.indexOf(document.activeElement as HTMLElement);if(e.shiftKey&&i<=0){e.preventDefault();nodes.at(-1)?.focus()}else if(!e.shiftKey&&(i===nodes.length-1||i<0)){e.preventDefault();nodes[0]?.focus()}}};
    window.addEventListener('keydown',key,true);return()=>{window.removeEventListener('keydown',key,true);previous?.isConnected&&previous.focus()};
  },[active,root,onClose]);
}
