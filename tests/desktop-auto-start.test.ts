// Fresh synthetic profiles and local ports exercise actual initialization and spending guards.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';

import { prepareDesktopBuyer } from '@gyblos/buyer/desktop-startup';
import { parseBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { DEVNET, DEVNET_USDC, FILE_MODES } from '@gyblos/config';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { buyerEnvironment } from '@gyblos/desktop/x402-managed';
import { automaticBuyer } from '@gyblos/desktop/x402-startup';

import { home, role } from './support/buyer-init';
function policy() { return { version:1, policyId:'00000000-0000-4000-8000-000000000001',model:'qwen3-0.6b',maxTokens:128,maxAtomic:'0',network:DEVNET,mint:DEVNET_USDC,payer:role().role === 'buyer' ? '11111111111111111111111111111111':'11111111111111111111111111111111' }; }

void test('desktop creates private zero-price open settings once, preserving the existing home on restart', async () => {
  const f = await home(); let roles = 0;
  const options = { environment: f.environment, prepareRole: async () => { roles++; return role(); } };
  try {
    await prepareDesktopBuyer(options);
    const bytes = await readFile(f.path, 'utf8');
    const config = parseBuyerSelectionConfig(JSON.parse(bytes));
    assert.deepEqual(config.sellers, []);
    assert.equal(config.discovery?.open, true);
    assert.ok(config.identity);
    assert.equal(config.request.maxAtomic, '0');
    assert.deepEqual(config.request.priceCeilings, {inputAtomicPerMtok:'0',outputAtomicPerMtok:'0'});
    assert.equal((await stat(f.path)).mode & FILE_MODES.permissionMask, FILE_MODES.privateFile);
    await prepareDesktopBuyer(options);
    assert.equal(roles, 1); assert.equal(await readFile(f.path,'utf8'), bytes);
  } finally { await rm(f.directory,{recursive:true,force:true}); }
});
void test('desktop leaves invalid existing settings intact for runtime validation', async () => {
  const f = await home();
  try {
    await mkdir(dirname(f.path), {recursive:true,mode:FILE_MODES.privateDirectory});
    await writeFile(f.path, 'invalid synthetic settings', {mode:FILE_MODES.privateFile});
    await prepareDesktopBuyer({environment:f.environment,prepareRole:async()=>{throw new Error('must not prepare');}});
    assert.equal(await readFile(f.path,'utf8'),'invalid synthetic settings');
  } finally { await rm(f.directory,{recursive:true,force:true}); }
});
void test('desktop optional relay token never inherits operator financial variables or home', () => {
  const environment = buyerEnvironment('/synthetic-profile', undefined, {GYBLOS_HOME:'/other',GYBLOS_RELAY_TOKEN:'secret',GYBLOS_RPC_URL:'https://not-used.invalid',GYBLOS_SESSION_ENABLED:'1'});
  assert.deepEqual(environment,{GYBLOS_HOME:'/synthetic-profile'});
  assert.throws(()=>buyerEnvironment('/profile','bad\ntoken',{}));
});
function runtime(maxAtomic = '0') {
  let starts = 0; let closes = 0; let writes = 0; let saved: string | undefined;
  const budget = new X402Budget({read:async()=>saved,write:async(text)=>{writes++;saved=text;}});
  const checked = {...policy(),maxAtomic};
  const client = new X402Client(budget,async()=>Response.json(checked));
  const service = {start:async()=>{starts++;return {url:'http://127.0.0.1:8090/v1/chat/completions',token:'synthetic-private-token'};},stop:async()=>{},close:async()=>{closes++;}};
  const buyer = automaticBuyer(service,client,budget);
  return {buyer,budget,client,service,checked,starts:()=>starts,closes:()=>closes,writes:()=>writes};
}
void test('automatic startup coalesces requests, connects once and enables free chat with zero permission', async () => {
  const r=runtime(); await Promise.all([r.buyer.start(),r.buyer.start()]);
  assert.equal(r.starts(),1); assert.equal(r.client.policy()?.maxAtomic,'0');
  const s=await r.budget.summary();assert.equal(s.active,true);assert.equal(s.limitAtomic,'0');
  await r.buyer.start();assert.equal(r.starts(),1);await r.buyer.close();assert.equal(r.closes(),1);
  await assert.rejects(r.buyer.start());
});
void test('automatic startup never authorizes a positive policy or clears uncertain spending', async () => {
  const paid=runtime('1');await paid.buyer.start();assert.equal((await paid.budget.summary()).active,false);await paid.buyer.close();
  const pending=runtime();await pending.budget.authorize(pending.checked,'0');await pending.budget.reserve('unfinished');
  const before=pending.writes();await assert.rejects(pending.buyer.start());assert.equal(pending.writes(),before);assert.equal((await pending.budget.summary()).blocked,true);await pending.buyer.close();
});
