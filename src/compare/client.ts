// SPDX-License-Identifier: MIT OR Apache-2.0
// This module deliberately does not import the main editor's backend queue,
// document IDs, caches, reset function, or session-invalidated event.
import {invoke} from '@tauri-apps/api/core';
import type {Progress} from './types';
export const compareResetEvent='jerrivell-compare-only-reset';
let generation=0;
export async function compareCall<T>(command:string,args:Record<string,unknown>={}):Promise<T>{
  const version=generation;
  try{return await invoke<T>('compare_call',{command,args})}catch(error){
    if(version===generation&&message(error).includes('COMPARE_RESET:')){generation++;window.dispatchEvent(new Event(compareResetEvent))}
    throw error;
  }
}
export const comparePoll=()=>invoke<{guardReady:boolean;progress:Progress}>('compare_poll');
export const compareReset=()=>{generation++;return invoke<void>('compare_reset')};
export const compareClose=()=>invoke<void>('compare_close');
export const message=(error:unknown)=>String(error instanceof Error?error.message:error);
