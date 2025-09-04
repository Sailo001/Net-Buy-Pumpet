// index.js
// package.json should include: { "type": "module" }

import 'dotenv/config';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import { Telegraf, Markup } from 'telegraf';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram
} from '@solana/web3.js';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import { createServer } from 'http';

import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction
} from '@solana/spl-token';

const { buildSwapInstruction } = require('@raydium-io/raydium-sdk');

/* ---------- tiny logger ---------- */
const ts = () => new Date().toISOString();
const log = (...args) => console.log(`[${ts()}]`, ...args);
const warn = (...args) => console.warn(`[${ts()}] ⚠️`, ...args);
const error = (...args) => console.error(`[${ts()}] 💥`, ...args);

/* ---------- ENV & validation ---------- */
const {
  TELEGRAM_BOT_TOKEN,
  ADMIN_CHAT_ID,
  SOLANA_PRIVATE_KEY,
  SOLANA_RPC_URL,
  JITO_TIP_AMOUNT,
  WALLET_PRIVATE_KEYS,
  NODE_ENV,
  RENDER_EXTERNAL_URL,
  PORT
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
if (!ADMIN_CHAT_ID) throw new Error('Missing ADMIN_CHAT_ID (Telegram user id)');
if (!SOLANA_PRIVATE_KEY) throw new Error('Missing SOLANA_PRIVATE_KEY');

const ADMIN = String(ADMIN_CHAT_ID).trim();
if (!/^\d+$/.test(ADMIN)) throw new Error('ADMIN_CHAT_ID must be numeric string');

const RPC_URL = SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const jitoTip = Number(JITO_TIP_AMOUNT) || 0;
const PORT_NUM = Number(PORT) || 3000;

/* ---------- helpers for key parsing ---------- */
function parseKeypairInput(value, label = 'KEY') {
  if (!value) throw new Error(`${label} empty`);
  // try bs58
  try {
    const secret = bs58.decode(value.trim());
    if (secret.length === 64) return Keypair.fromSecretKey(secret);
    // allow JSON array fallback
  } catch (_) {}
  // try JSON array
  try {
    const arr = JSON.parse(value);
    if (Array.isArray(arr)) {
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
  } catch (_) {}
  throw new Error(`${label} invalid (expected bs58 or JSON array)`);
}

function parseWalletKeys(env) {
  const wallets = [];
  if (!env) return wallets;
  // allow JSON array or CSV
  try {
    const parsed = JSON.parse(env);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        try {
          const kp = Array.isArray(item)
            ? Keypair.fromSecretKey(Uint8Array.from(item))
            : parseKeypairInput(String(item), 'WALLET_KEYS item');
          wallets.push(kp);
        } catch (e) {
          warn('Skipping wallet key (invalid):', e.message);
        }
      }
      return wallets;
    }
  } catch (_) {
    // not JSON; fallback to CSV
  }
  for (const part of env.split(',').map(s => s.trim()).filter(Boolean)) {
    try {
      wallets.push(parseKeypairInput(part, 'WALLET_KEYS item'));
    } catch (e) {
      warn('Skipping wallet key (invalid):', e.message);
    }
  }
  return wallets;
}

/* ---------- core singletons ---------- */
const connection = new Connection(RPC_URL, 'confirmed');
let payer;
try {
  payer = parseKeypairInput(SOLANA_PRIVATE_KEY, 'SOLANA_PRIVATE_KEY');
  log('Main payer publicKey:', payer.publicKey.toString());
} catch (e) {
  error('Failed to parse payer key:', e.message);
  throw e;
}

const extraWalletKps = parseWalletKeys(WALLET_PRIVATE_KEYS);
log(`Parsed ${extraWalletKps.length} extra wallet(s)`);

const bot = new Telegraf(TELEGRAM_BOT_TOKEN, { handlerTimeout: 90_000 });

/* ---------- runtime state ---------- */
let running = false;
let isShuttingDown = false;

const session = {
  mint: null,
  buySol: 0,
  sellPct: 0,
  delaySec: 2,
  buyScale: 1.1,
  multiBuys: 1,
  mevProtection: true,
  multiWallet: extraWalletKps.length > 0
};

const SETUP_STEPS = {
  WAITING_CONTRACT: 'waiting_contract',
  WAITING_SOL_AMOUNT: 'waiting_sol_amount',
  WAITING_SELL_PCT: 'waiting_sell_pct',
  WAITING_DELAY: 'waiting_delay',
  WAITING_MULTI_BUYS: 'waiting_multi_buys',
  CONFIRMATION: 'confirmation'
};

const setupFlow = { users: new Map(), data: new Map() };
function getCurrentStep(userId) { return setupFlow.users.get(userId); }
function setUserStep(userId, step) { setupFlow.users.set(userId, step); log('setUserStep', userId, step); }
function getUserData(userId) { if (!setupFlow.data.has(userId)) setupFlow.data.set(userId, {}); return setupFlow.data.get(userId); }
function clearUserSetup(userId) { setupFlow.users.delete(userId); setupFlow.data.delete(userId); log('clearUserSetup', userId); }

/* ---------- MEVProtection class ---------- */
class MEVProtection {
  constructor() { this.mevHistory = []; this.attackPatterns = new Map(); }
  async detectMEVActivity(mint) {
    try {
      log('MEV detect for', mint);
      const sigs = await connection.getConfirmedSignaturesForAddress2(new PublicKey(mint), { limit: 50 });
      const txs = await Promise.all(sigs.slice(0,20).map(s => connection.getTransaction(s.signature, { commitment: 'confirmed' })));
      const indicators = { frontRuns: 0, sandwiches: 0, copyTrades: 0, totalTxs: txs.filter(Boolean).length };
      const score = this.calculateMEVRisk(indicators);
      return { riskScore: score, indicators, recommendation: this.getProtectionRecommendation(score) };
    } catch (err) {
      warn('MEV detection error:', err.message || err);
      return { riskScore: 0.5, indicators: { totalTxs: 0 }, recommendation: 'medium' };
    }
  }
  calculateMEVRisk(indicators) {
    const t = indicators.totalTxs || 0;
    if (t === 0) return 0.5;
    return Math.min(0.8, t > 100 ? 0.7 : 0.3);
  }
  getProtectionRecommendation(score) { if (score < 0.3) return 'low'; if (score < 0.7) return 'medium'; return 'high'; }
  splitTransaction(amount, protection = 'medium') {
    const cfg = { low: {chunks:2,variance:0.1}, medium: {chunks:3,variance:0.2}, high: {chunks:5,variance:0.3} };
    const { chunks, variance } = cfg[protection] || cfg.medium;
    const base = amount / chunks; const arr = [];
    for (let i=0;i<chunks;i++){ const rf = 1 + (Math.random()-0.5)*variance; arr.push(base*rf); }
    const tot = arr.reduce((s,x)=>s+x,0); return arr.map(x => (x/tot)*amount);
  }
  generateDelays(count, protection='medium') {
    const cfg = { low:{min:100,max:1000}, medium:{min:200,max:2000}, high:{min:500,max:3000} };
    const { min, max } = cfg[protection] || cfg.medium;
    return Array.from({length:count}, ()=> Math.floor(Math.random()*(max-min)+min));
  }
}
const mevProtection = new MEVProtection();

/* ---------- MultiWalletOrchestrator ---------- */
class MultiWalletOrchestrator {
  constructor(extraKps=[]) {
    this.wallets = [];
    this.loadWallets(extraKps);
  }
  loadWallets(extraKps=[]) {
    try {
      this.wallets.push({ keypair: payer, role: 'main', active: true, balance: 0 });
      for (let i=0;i<extraKps.length;i++){
        try {
          this.wallets.push({ keypair: extraKps[i], role: `wallet_${i+1}`, active: true, balance: 0 });
        } catch (e) { warn('skip extra wallet', e.message); }
      }
      log('Multi-wallet loaded:', this.wallets.map(w=>w.keypair.publicKey.toString().slice(0,8)));
    } catch (e) { error('loadWallets error', e); }
  }
  getActiveWallets() { return this.wallets.filter(w=>w.active); }
  distributeAmount(totalAmount, walletCount=null) {
    const active = this.getActiveWallets();
    const use = walletCount || Math.min(active.length, 3);
    if (use <= 0) return [];
    const amounts = []; let remaining = totalAmount;
    for (let i=0;i<use-1;i++){
      const pct = 0.2 + Math.random()*0.2;
      const amt = +(remaining * pct).toFixed(8);
      amounts.push(amt); remaining -= amt;
    }
    amounts.push(+remaining.toFixed(8));
    // shuffle
    for (let i=amounts.length-1;i>0;i--){
      const j = Math.floor(Math.random()*(i+1)); [amounts[i],amounts[j]]=[amounts[j],amounts[i]];
    }
    log('distributeAmount', amounts);
    return amounts;
  }
  generateNaturalDelays(count){ if (count<=0) return []; const d=[]; for (let i=0;i<count;i++){ const base=500+Math.random()*7500; const cluster = Math.random()<0.3?Math.random()*2000:0; d.push(Math.floor(base+cluster)); } log('natural delays', d); return d; }
  async executeCoordinatedBuy(mint, totalAmount, protection=true) {
    const active = this.getActiveWallets(); const use = Math.min(active.length,3);
    if (use<=0) throw new Error('no active wallets');
    const amounts = this.distributeAmount(totalAmount, use);
    const delays = this.generateNaturalDelays(use-1);
    const results = [];
    for (let i=0;i<use;i++){
      const walletObj = active[i];
      const amount = amounts[i];
      try {
        log(`wallet ${i+1} buying ${amount} SOL`, walletObj.keypair.publicKey.toString().slice(0,8));
        const tx = await this.executeBuyWithWallet(walletObj, mint, amount, protection);
        results.push({ wallet: walletObj.role, amount, tx });
        log('wallet buy result', tx);
      } catch (err) {
        warn('wallet buy failed', err.message || err);
        results.push({ wallet: walletObj.role, amount, error: err.message || String(err) });
      }
      if (i < delays.length) await new Promise(r=>setTimeout(r, delays[i]));
    }
    return results;
  }
  async executeBuyWithWallet(walletObj, mint, solAmount, mevProtectionFlag=true) {
    if (!mint) throw new Error('mint required');
    const pool = await getRaydiumPoolInfo(mint);
    if (!pool) throw new Error('no pool for mint');
    const WSOL = 'So11111111111111111111111111111111111111112';
    const wallet = walletObj.keypair;
    const userWSOL = await ensureATA(WSOL, wallet.publicKey);
    const amountIn = Math.floor(solAmount * LAMPORTS_PER_SOL);
    const wsolInfo = await connection.getAccountInfo(userWSOL);
    if (!wsolInfo) {
      const createTx = new Transaction().add(createAssociatedTokenAccountInstruction(wallet.publicKey, userWSOL, wallet.publicKey, new PublicKey(WSOL), TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      await connection.sendTransaction(createTx, [wallet]);
    }
    const wrapTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: userWSOL, lamports: amountIn }), createSyncNativeInstruction(userWSOL));
    if (mevProtectionFlag) await sendPrivateTransactionWithWallet(wrapTx, wallet);
    else await connection.sendTransaction(wrapTx, [wallet]);
    const toMint = pool.baseMint === mint ? mint : WSOL;
    const userOutATA = await ensureATA(toMint, wallet.publicKey);
    const swapIx = await buildSwapInstruction({
      poolKeys: pool,
      userKeys: { tokenAccountIn: userWSOL, tokenAccountOut: userOutATA, owner: wallet.publicKey, payer: wallet.publicKey },
      amountIn,
      minAmountOut: 1,
      direction: pool.baseMint === mint ? 'quote2base' : 'base2quote'
    });
    const swapTx = new Transaction();
    if (swapIx?.innerTransactions) swapIx.innerTransactions.forEach(t => (t.instructions||[]).forEach(ix=>swapTx.add(ix)));
    else if (swapIx?.instructions) swapIx.instructions.forEach(ix=>swapTx.add(ix));
    else if (Array.isArray(swapIx)) swapIx.forEach(ix=>swapTx.add(ix));
    if (mevProtectionFlag) return await sendPrivateTransactionWithWallet(swapTx, wallet);
    return await connection.sendTransaction(swapTx, [wallet]);
  }
}
const multiWallet = new MultiWalletOrchestrator([ ...extraWalletKps ]);

/* ---------- helper utilities ---------- */
async function fetchWithTimeout(url, opts={}, timeoutMs=8000) {
  const controller = new AbortController();
  const id = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal }); clearTimeout(id); return r;
  } catch (e) { clearTimeout(id); throw e; }
}

async function getRaydiumPoolInfo(mintAddress) {
  if (!mintAddress) throw new Error('mintAddress required');
  const url = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
  try {
    const resp = await fetchWithTimeout(url, {}, 8000);
    if (!resp.ok) throw new Error('Raydium pool list HTTP ' + resp.status);
    const pools = await resp.json();
    for (const sid in pools.official) { const pool = pools.official[sid]; if (pool.baseMint === mintAddress || pool.quoteMint === mintAddress) { pool.id = sid; return pool; } }
    for (const sid in pools.unOfficial) { const pool = pools.unOfficial[sid]; if (pool.baseMint === mintAddress || pool.quoteMint === mintAddress) { pool.id = sid; return pool; } }
    throw new Error('No Raydium pool found for mint: ' + mintAddress);
  } catch (err) {
    warn('getRaydiumPoolInfo error', err.message || err); throw err;
  }
}

async function getATA(mint, owner) {
  if (!mint || !owner) throw new Error('getATA: mint & owner required');
  return await getAssociatedTokenAddress(new PublicKey(mint), owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

async function ensureATA(mint, owner) {
  const ata = await getATA(mint, owner);
  const info = await connection.getAccountInfo(ata);
  if (!info) {
    log('Creating ATA', mint.slice(0,8), 'for', owner.toString().slice(0,8));
    const tx = new Transaction().add(createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, new PublicKey(mint), TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    const sig = await connection.sendTransaction(tx, [payer], { skipPreflight:false, preflightCommitment: 'confirmed' });
    log('ATA created tx', sig);
  }
  return ata;
}

/* ---------- MEV-protected trading functions ---------- */

async function sendPrivateTransaction(transaction, tip = jitoTip || 10000) {
  try {
    if (tip > 0) {
      try {
        const tipIx = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'), lamports: tip });
        transaction.add(tipIx);
      } catch (e) { warn('add tip failed', e.message); }
    }
    const endpoint = MEV_CONFIG.privatePools[Math.floor(Math.random()*MEV_CONFIG.privatePools.length)];
    try {
      const payload = { jsonrpc:'2.0', id:1, method:'sendTransaction', params:[ transaction.serialize({ requireAllSignatures:false }).toString('base64'), { skipPreflight:false, preflightCommitment:'confirmed' } ] };
      const resp = await fetchWithTimeout(`${endpoint}/api/v1/transactions`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }, 8000);
      if (resp.ok) {
        const json = await resp.json();
        if (json?.result) { log('Jito result', json.result); return json.result; }
        warn('Jito no result', json);
      } else warn('Jito HTTP', resp.status);
    } catch (e) { warn('Jito failed, fallback', e.message); }
    const sig = await connection.sendTransaction(transaction, [payer], { skipPreflight:false, preflightCommitment:'confirmed' });
    log('sendTransaction sig', sig); return sig;
  } catch (err) { error('sendPrivateTransaction failed', err); throw err; }
}

async function sendPrivateTransactionWithWallet(transaction, wallet, tip = jitoTip || 10000) {
  try {
    if (tip > 0) {
      try {
        const tipIx = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'), lamports: tip });
        transaction.add(tipIx);
      } catch (e) { warn('add wallet tip failed', e.message); }
    }
    const endpoint = MEV_CONFIG.privatePools[Math.floor(Math.random()*MEV_CONFIG.privatePools.length)];
    try {
      const payload = { jsonrpc:'2.0', id:1, method:'sendTransaction', params:[ transaction.serialize({ requireAllSignatures:false }).toString('base64'), { skipPreflight:false, preflightCommitment:'confirmed' } ] };
      const resp = await fetchWithTimeout(`${endpoint}/api/v1/transactions`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }, 8000);
      if (resp.ok) {
        const json = await resp.json();
        if (json?.result) { log('Jito wallet result', json.result); return json.result; }
        warn('Jito wallet no result', json);
      } else warn('Jito wallet HTTP', resp.status);
    } catch (e) { warn('Jito wallet failed fallback', e.message); }
    const sig = await connection.sendTransaction(transaction, [wallet], { skipPreflight:false, preflightCommitment:'confirmed' });
    log('wallet sendTransaction sig', sig); return sig;
  } catch (err) { error('sendPrivateTransactionWithWallet failed', err); throw err; }
}

async function buyTokenSingle(mint, solAmount) {
  if (!mint) throw new Error('buyTokenSingle: mint required');
  if (!Number.isFinite(solAmount) || solAmount <= 0) throw new Error('invalid solAmount');
  log('buyTokenSingle', mint, solAmount);
  const pool = await getRaydiumPoolInfo(mint);
  const buyingBase = (pool.baseMint === mint);
  const WSOL = 'So11111111111111111111111111111111111111112';
  const userWSOL = await ensureATA(WSOL, payer.publicKey);
  const amountIn = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const raw = await connection.getTokenAccountBalance(userWSOL).catch(()=>null);
  const wsolBalance = Number(raw?.value?.amount || 0);
  if (wsolBalance < amountIn) {
    const wrapTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: userWSOL, lamports: amountIn }), createSyncNativeInstruction(userWSOL));
    await sendPrivateTransaction(wrapTx);
  }
  const userOutATA = await ensureATA(buyingBase ? mint : WSOL, payer.publicKey);
  const swapIx = await buildSwapInstruction({
    poolKeys: pool,
    userKeys: { tokenAccountIn: userWSOL, tokenAccountOut: userOutATA, owner: payer.publicKey, payer: payer.publicKey },
    amountIn,
    minAmountOut: 1,
    direction: buyingBase ? 'quote2base' : 'base2quote'
  });
  const tx = new Transaction();
  if (swapIx?.innerTransactions) swapIx.innerTransactions.forEach(t => (t.instructions||[]).forEach(ix=>tx.add(ix)));
  else if (swapIx?.instructions) swapIx.instructions.forEach(ix=>tx.add(ix));
  else if (Array.isArray(swapIx)) swapIx.forEach(ix=>tx.add(ix));
  return await sendPrivateTransaction(tx);
}

async function buyTokenMEVProtected(mint, solAmount) {
  log('buyTokenMEVProtected start', mint, solAmount);
  const analysis = await mevProtection.detectMEVActivity(mint);
  const protection = analysis.recommendation || 'medium';
  const chunks = mevProtection.splitTransaction(solAmount, protection);
  const delays = mevProtection.generateDelays(Math.max(0, chunks.length-1), protection);
  const results = [];
  for (let i=0;i<chunks.length;i++){
    try {
      const tx = await buyTokenSingle(mint, chunks[i]);
      results.push(tx);
      log('chunk bought', tx);
    } catch (e) { warn('chunk failed', e.message || e); results.push({ error: e.message || String(e) }); }
    if (i < delays.length) await new Promise(r=>setTimeout(r, delays[i]));
  }
  return results;
}

async function sellTokenSingle(mint, sellPct) {
  if (!mint) throw new Error('sellTokenSingle: mint required');
  if (!Number.isFinite(sellPct) || sellPct <= 0) throw new Error('invalid sellPct');
  const pool = await getRaydiumPoolInfo(mint);
  const baseMint = pool.baseMint;
  const WSOL = 'So11111111111111111111111111111111111111112';
  const userBaseATA = await ensureATA(baseMint, payer.publicKey);
  const userWSOL = await ensureATA(WSOL, payer.publicKey);
  const rawBal = await connection.getTokenAccountBalance(userBaseATA);
  const bal = Number(rawBal?.value?.amount || 0);
  const amountIn = Math.floor(bal * (sellPct/100));
  if (amountIn < 1) throw new Error('Not enough token balance to sell');
  const swapIx = await buildSwapInstruction({
    poolKeys: pool,
    userKeys: { tokenAccountIn: userBaseATA, tokenAccountOut: userWSOL, owner: payer.publicKey, payer: payer.publicKey },
    amountIn,
    minAmountOut: 1,
    direction: 'base2quote'
  });
  const tx = new Transaction();
  if (swapIx?.innerTransactions) swapIx.innerTransactions.forEach(t => (t.instructions||[]).forEach(ix=>tx.add(ix)));
  else if (swapIx?.instructions) swapIx.instructions.forEach(ix=>tx.add(ix));
  else if (Array.isArray(swapIx)) swapIx.forEach(ix=>tx.add(ix));
  return await sendPrivateTransaction(tx);
}

async function sellTokenMEVProtected(mint, sellPct) {
  log('sellTokenMEVProtected', mint, sellPct);
  const analysis = await mevProtection.detectMEVActivity(mint);
  const protection = analysis.recommendation || 'medium';
  if (sellPct === 100 || protection === 'high') {
    return [await sellTokenSingle(mint, sellPct)];
  } else {
    const chunks = Math.min(3, Math.ceil(sellPct/25));
    const chunkPct = sellPct / chunks;
    const delays = mevProtection.generateDelays(Math.max(0,chunks-1), protection);
    const results = [];
    for (let i=0;i<chunks;i++){
      try { const tx = await sellTokenSingle(mint, chunkPct); results.push(tx); } catch (e) { warn('sell chunk failed', e.message || e); results.push({ error: e.message || String(e) }); }
      if (i < delays.length) await new Promise(r=>setTimeout(r, delays[i]));
    }
    return results;
  }
}

/* ---------- menus & helpers ---------- */
function getMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⚙️ Setup Configuration', 'start_setup')],
    [Markup.button.callback('📊 View Status', 'refresh_status')],
    [Markup.button.callback('🔥 Start Pump', 'start_pump')],
    [Markup.button.callback('⏹️ Stop Pump', 'stop_pump')],
    [Markup.button.callback('💰 Sell All Tokens', 'sell_all_confirm')],
    [Markup.button.callback('🎭 Multi-Wallet Status', 'multiwallet_status')],
    [Markup.button.callback('🛡️ Advanced Settings', 'advanced_menu')],
    [Markup.button.callback('🔄 Refresh Menu', 'main_menu')]
  ]);
}
function getAdvancedMenu(){ return Markup.inlineKeyboard([[Markup.button.callback('🛡️ Toggle MEV Protection','toggle_mev')],[Markup.button.callback('🎭 Toggle Multi-Wallet','toggle_multiwallet')],[Markup.button.callback('🔍 MEV Analysis','analyze_mev')],[Markup.button.callback('🏠 Main Menu','main_menu')]]); }
function getSetupMenu(){ return Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Setup','cancel_setup')],[Markup.button.callback('🏠 Main Menu','main_menu')]]); }
function getStatusMenu(){ return Markup.inlineKeyboard([[Markup.button.callback('⚙️ New Setup','start_setup')],[Markup.button.callback('🔥 Start Pump','start_pump')],[Markup.button.callback('💰 Sell All','sell_all_confirm')],[Markup.button.callback('🛡️ Advanced Settings','advanced_menu')],[Markup.button.callback('🏠 Main Menu','main_menu')]]); }

function showCurrentConfig() {
  return [
    '📊 **Current Configuration:**',
    '',
    `🎯 **Token:** ${session.mint || 'Not set'}`,
    `💰 **Buy Amount:** ${session.buySol || 0} SOL`,
    `📈 **Sell Percentage:** ${session.sellPct || 0}%`,
    `⏱️ **Delay:** ${session.delaySec || 0} seconds`,
    `🔄 **Multi-Buys:** ${session.multiBuys || 0} per cycle`,
    `📈 **Buy Scaling:** ${session.buyScale || 1.0}x`,
    '',
    '🛡️ **Advanced Features:**',
    `🛡️ MEV Protection: ${session.mevProtection ? '🟢 ON' : '🔴 OFF'}`,
    `🎭 Multi-Wallet: ${session.multiWallet ? '🟢 ON' : '🔴 OFF'}`,
    `🎭 Available Wallets: ${multiWallet.getActiveWallets().length}`
  ].join('\n');
}

/* ---------- Telegram handlers ---------- */

// /start
bot.start(ctx => {
  const uid = String(ctx.from.id);
  log('/start by', uid, ctx.from.username || '');
  if (uid !== ADMIN) return;
  const welcome = [
    '🤖 **Welcome to Net-Buy-Pumpet!**',
    '',
    `🎯 Token: ${session.mint ? `${session.mint.slice(0,8)}...` : '❌ Not configured'}`,
    `🔄 Bot: ${running ? '🟢 Active' : '🔴 Stopped'}`,
    `🎭 Wallets: ${multiWallet.getActiveWallets().length} loaded`,
    '',
    '👇 **Choose an action below:**'
  ].join('\n');
  ctx.reply(welcome, { ...getMainMenu(), parse_mode: 'Markdown' });
});

// /setup
bot.command('setup', ctx => {
  const uid = String(ctx.from.id);
  if (uid !== ADMIN) return;
  log('/setup called by', uid);
  clearUserSetup(uid);
  setUserStep(uid, SETUP_STEPS.WAITING_CONTRACT);
  ctx.reply('🔧 **Pump Setup - Step 1/5**\n\n🎯 Enter token contract (mint) address', { ...getSetupMenu(), parse_mode:'Markdown' });
});

// /status
bot.command('status', ctx => {
  const uid = String(ctx.from.id);
  if (uid !== ADMIN) return;
  ctx.reply(showCurrentConfig(), { ...getStatusMenu(), parse_mode: 'Markdown' });
});

// /advanced
bot.command('advanced', ctx => {
  const uid = String(ctx.from.id);
  if (uid !== ADMIN) return;
  ctx.reply('🛡️ Advanced features', { ...getAdvancedMenu(), parse_mode:'Markdown' });
});

// /help
bot.command('help', ctx => {
  const uid = String(ctx.from.id);
  if (uid !== ADMIN) return;
  ctx.reply('Help: use buttons or /setup to configure', { ...getMainMenu(), parse_mode:'Markdown' });
});

/* Setup text handler (step flow) */
bot.on('text', async ctx => {
  const uid = String(ctx.from.id);
  if (uid !== ADMIN) return;
  const text = (ctx.message.text || '').trim();
  const step = getCurrentStep(uid);
  log('text from', uid, 'step', step, text.slice(0,80));
  if (!step) {
    if (text && !text.startsWith('/')) ctx.reply('Use menu or /help', getMainMenu());
    return;
  }
  const userData = getUserData(uid);

  try {
    switch (step) {
      case SETUP_STEPS.WAITING_CONTRACT:
        // strict validation: Solana pubkey is base58 length ~43-44 typically
        if (!text || text.length < 32 || text.length > 64) {
          ctx.reply('❌ Invalid mint address length. Please paste a valid Solana mint.');
          return;
        }
        // quick sanity: try to get pool info; this may throw when not found
        try {
          await getRaydiumPoolInfo(text);
          userData.mint = text;
          setUserStep(uid, SETUP_STEPS.WAITING_SOL_AMOUNT);
          ctx.reply('✅ Token found. Now enter SOL amount per buy (e.g., 0.1)', getSetupMenu());
        } catch (err) {
          warn('mint validation failed:', err.message || err);
          ctx.reply(`❌ Token not found on Raydium: ${err.message}`, getSetupMenu());
        }
        break;

      case SETUP_STEPS.WAITING_SOL_AMOUNT:
        {
          const v = Number(text);
          if (!Number.isFinite(v) || v <= 0 || v > 1000) { ctx.reply('❌ Enter a valid number (0.001 - 1000)'); return; }
          userData.buySol = v;
          setUserStep(uid, SETUP_STEPS.WAITING_SELL_PCT);
          ctx.reply('✅ SOL amount set. Now enter sell % after each cycle (0-100)', getSetupMenu());
        }
        break;

      case SETUP_STEPS.WAITING_SELL_PCT:
        {
          const p = Number(text);
          if (!Number.isFinite(p) || p < 0 || p > 100) { ctx.reply('❌ Enter a percentage 0-100'); return; }
          userData.sellPct = p;
          setUserStep(uid, SETUP_STEPS.WAITING_DELAY);
          ctx.reply('✅ Sell % set. Now enter delay between rounds (seconds)', getSetupMenu());
        }
        break;

      case SETUP_STEPS.WAITING_DELAY:
        {
          const d = Number(text);
          if (!Number.isFinite(d) || d < 1 || d > 86400) { ctx.reply('❌ Delay must be >=1 second'); return; }
          userData.delaySec = d;
          setUserStep(uid, SETUP_STEPS.WAITING_MULTI_BUYS);
          ctx.reply('✅ Delay set. Enter multi-buys per cycle (1-10)', getSetupMenu());
        }
        break;

      case SETUP_STEPS.WAITING_MULTI_BUYS:
        {
          const m = Number(text);
          if (!Number.isInteger(m) || m < 1 || m > 10) { ctx.reply('❌ Enter integer 1-10'); return; }
          userData.multiBuys = m;
          setUserStep(uid, SETUP_STEPS.CONFIRMATION);
          const confirmK = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm & Save','confirm_setup')],
            [Markup.button.callback('❌ Cancel Setup','cancel_setup')],
            [Markup.button.callback('🔄 Start Over','start_setup')],
            [Markup.button.callback('🏠 Main Menu','main_menu')]
          ]);
          ctx.reply('🎉 Setup complete:\n' + [
            `Token: ${userData.mint}`,
            `Buy SOL: ${userData.buySol}`,
            `Sell %: ${userData.sellPct}`,
            `Delay: ${userData.delaySec}s`,
            `Multi-buys: ${userData.multiBuys}`
          ].join('\n'), { ...confirmK, parse_mode:'Markdown' });
        }
        break;

      default:
        ctx.reply('Unknown setup step; cancelled', getMainMenu());
        clearUserSetup(uid);
        break;
    }
  } catch (err) {
    error('setup handler error', err);
    ctx.reply('❌ Error in setup: ' + (err.message || String(err)), getSetupMenu());
    clearUserSetup(uid);
  }
});

/* ---------- Inline button handlers (complete block) ---------- */
bot.on('callback_query', async (ctx) => {
  try {
    const userId = String(ctx.from.id);
    const data = ctx.callbackQuery?.data;
    log('callback_query', userId, data);
    if (userId !== ADMIN) { await ctx.answerCbQuery('Unauthorized'); return; }

    switch (data) {
      case 'start_setup':
        clearUserSetup(userId); setUserStep(userId, SETUP_STEPS.WAITING_CONTRACT);
        await ctx.editMessageText('🔧 Pump Setup - Step 1/5\nEnter token mint', { ...getSetupMenu(), parse_mode:'Markdown' });
        break;

      case 'cancel_setup':
        clearUserSetup(userId);
        await ctx.editMessageText('❌ Setup cancelled', { ...getMainMenu(), parse_mode:'Markdown' });
        break;

      case 'confirm_setup':
        {
          const ud = getUserData(userId);
          session.mint = ud.mint; session.buySol = ud.buySol; session.sellPct = ud.sellPct; session.delaySec = ud.delaySec; session.multiBuys = ud.multiBuys;
          clearUserSetup(userId);
          await ctx.editMessageText('✅ Configuration saved\n' + showCurrentConfig(), { ...getMainMenu(), parse_mode:'Markdown' });
        }
        break;

      case 'refresh_status':
        await ctx.editMessageText(showCurrentConfig(), { ...getStatusMenu(), parse_mode:'Markdown' });
        break;

      case 'start_pump':
        if (!session.mint || !session.buySol) { await ctx.answerCbQuery('Complete setup first'); return; }
        if (running) { await ctx.answerCbQuery('Pump already running'); return; }
        running = true;
        await ctx.editMessageText('🔥 Pump started\n' + showCurrentConfig(), { ...getStatusMenu(), parse_mode:'Markdown' });
        startPumpLoop().catch(err => { error('pump loop error', err); running = false; });
        break;

      case 'stop_pump':
        if (!running) { await ctx.answerCbQuery('Pump not running'); return; }
        running = false; await ctx.editMessageText('⏹️ Pump stop requested', { ...getMainMenu(), parse_mode:'Markdown' });
        break;

      case 'sell_all_confirm':
        if (!session.mint) { await ctx.answerCbQuery('No token set'); return; }
        try {
          await ctx.editMessageText('⏳ Selling all tokens...', { parse_mode:'Markdown' });
          const res = session.mevProtection ? await sellTokenMEVProtected(session.mint, 100) : [await sellTokenSingle(session.mint, 100)];
          await ctx.reply('✅ Sell executed\n' + JSON.stringify(res, null, 2), { ...getMainMenu(), parse_mode:'Markdown' });
        } catch (e) { warn('sell all failed', e.message || e); await ctx.reply('Sell failed: '+(e.message||String(e))); }
        break;

      case 'multiwallet_status':
        {
          const w = multiWallet.getActiveWallets();
          await ctx.editMessageText('Multi-wallet status:\n' + w.map((x,i)=>`#${i+1}: ${x.keypair.publicKey.toString().slice(0,8)}...`).join('\n'), { ...getMainMenu(), parse_mode:'Markdown' });
        }
        break;

      case 'advanced_menu':
        await ctx.editMessageText('Advanced menu', { ...getAdvancedMenu(), parse_mode:'Markdown' });
        break;

      case 'toggle_mev':
        session.mevProtection = !session.mevProtection; await ctx.editMessageText(`MEV: ${session.mevProtection}`, { ...getAdvancedMenu(), parse_mode:'Markdown' });
        break;

      case 'toggle_multiwallet':
        session.multiWallet = !session.multiWallet; await ctx.editMessageText(`Multi-wallet: ${session.multiWallet}`, { ...getAdvancedMenu(), parse_mode:'Markdown' });
        break;

      case 'analyze_mev':
        if (!session.mint) { await ctx.answerCbQuery('Set token first'); return; }
        const analysis = await mevProtection.detectMEVActivity(session.mint);
        await ctx.editMessageText(`MEV risk: ${analysis.riskScore}\nRecommendation: ${analysis.recommendation}`, { ...getAdvancedMenu(), parse_mode:'Markdown' });
        break;

      case 'main_menu':
        await ctx.editMessageText('Main Menu', { ...getMainMenu(), parse_mode:'Markdown' });
        break;

      default:
        warn('Unknown callback', data); await ctx.answerCbQuery('Unknown action'); break;
    }

    try { await ctx.answerCbQuery(); } catch (_) {}
  } catch (err) { error('callback handler', err); try { await ctx.answerCbQuery('Error'); } catch(_){} }
});

/* ---------- pump loop ---------- */
async function startPumpLoop() {
  if (!session.mint) throw new Error('no token configured');
  let cycle = 0; let buyAmount = session.buySol;
  const initialAnalysis = await mevProtection.detectMEVActivity(session.mint);
  await bot.telegram.sendMessage(ADMIN, `MEV Analysis: ${initialAnalysis.riskScore}`);
  while (running && !isShuttingDown) {
    cycle++; log('pump cycle', cycle, 'buyAmount', buyAmount);
    try {
      await bot.telegram.sendMessage(ADMIN, `Cycle ${cycle} starting: ${buyAmount} SOL`, { parse_mode:'Markdown' });
      for (let i=0;i<session.multiBuys && running;i++){
        try {
          if (session.multiWallet && multiWallet.getActiveWallets().length>1) {
            const results = await multiWallet.executeCoordinatedBuy(session.mint, buyAmount, session.mevProtection);
            for (const r of results) {
              if (r.tx) await bot.telegram.sendMessage(ADMIN, `✅ ${r.wallet} ${r.amount} SOL\nTx: ${r.tx}`, { parse_mode:'Markdown' });
              else await bot.telegram.sendMessage(ADMIN, `❌ ${r.wallet} failed: ${r.error}`, { parse_mode:'Markdown' });
            }
          } else if (session.mevProtection) {
            const txs = await buyTokenMEVProtected(session.mint, buyAmount);
            await bot.telegram.sendMessage(ADMIN, `✅ Protected buy results: ${JSON.stringify(txs)}`, { parse_mode:'Markdown' });
          } else {
            const tx = await buyTokenSingle(session.mint, buyAmount);
            await bot.telegram.sendMessage(ADMIN, `✅ Buy tx: ${tx}`, { parse_mode:'Markdown' });
          }
        } catch (e) { warn('buy error', e.message || e); await bot.telegram.sendMessage(ADMIN, `Buy failed: ${e.message || e}`); }
        if (i < session.multiBuys - 1) await new Promise(r=>setTimeout(r, 1000));
      }

      if (session.sellPct > 0 && running) {
        try {
          const sellRes = session.mevProtection ? await sellTokenMEVProtected(session.mint, session.sellPct) : [await sellTokenSingle(session.mint, session.sellPct)];
          await bot.telegram.sendMessage(ADMIN, `Sell results: ${JSON.stringify(sellRes)}`, { parse_mode:'Markdown' });
        } catch (e) { warn('sell error', e.message || e); await bot.telegram.sendMessage(ADMIN, `Sell failed: ${e.message || e}`); }
      }

      buyAmount *= session.buyScale;
      const baseDelayMs = (session.delaySec || 1) * 1000;
      const jitter = 0.8 + Math.random()*0.4;
      const delayMs = Math.max(500, baseDelayMs * jitter + (initialAnalysis.riskScore>0.7?2000:0));
      log('cycle delay', delayMs);
      await new Promise(r=>setTimeout(r, delayMs));
    } catch (err) {
      error('pump main loop error', err);
      await bot.telegram.sendMessage(ADMIN, `Cycle ${cycle} error: ${err.message || err}`, { parse_mode:'Markdown' });
    }
  }
  await bot.telegram.sendMessage(ADMIN, 'Pump stopped', { parse_mode:'Markdown' });
}

/* ---------- error handling & shutdown ---------- */
bot.catch((err, ctx) => {
  error('bot error', err);
  if (ctx) try { ctx.reply('Bot error: ' + (err.message||err)); } catch(e){ error('reply failed', e); }
});

async function gracefulShutdown() {
  if (isShuttingDown) return; isShuttingDown = true; running = false;
  log('gracefulShutdown initiated');
  try { await bot.telegram.sendMessage(ADMIN, 'Bot shutting down...'); } catch(e){ warn('notify admin failed', e.message); }
  try { await bot.stop(); log('bot stopped'); } catch(e){ error('bot.stop failed', e); }
  setTimeout(()=>{ log('exiting'); process.exit(0); }, 1500);
}
process.once('SIGINT', gracefulShutdown);
process.once('SIGTERM', gracefulShutdown);
process.on('unhandledRejection', (r,p)=> error('unhandledRejection', r,p));
process.on('uncaughtException', (e)=> { error('uncaughtException', e); gracefulShutdown(); });

/* ---------- health / webhook server ---------- */
const server = createServer((req, res) => {
  if (req.url === '/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        bot.handleUpdate(update);
        res.writeHead(200); res.end('OK');
      } catch (e) { error('webhook parse error', e); res.writeHead(400); res.end('Bad Request'); }
    });
    return;
  }
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ status:'healthy', bot_running: !isShuttingDown, pump_active: running, configured: !!session.mint, mev_protection: session.mevProtection, multi_wallet: session.multiWallet, wallet_count: multiWallet.getActiveWallets().length, timestamp: new Date().toISOString() }));
    return;
  }
  res.writeHead(404); res.end('Not Found');
});

server.listen(PORT_NUM, () => log('Health server listening on', PORT_NUM));

/* ---------- start bot (polling or webhook) ---------- */
async function startBot() {
  try {
    const useWebhook = NODE_ENV === 'production' && !!RENDER_EXTERNAL_URL;
    if (useWebhook) {
      const webhookUrl = `${RENDER_EXTERNAL_URL.replace(/\/$/, '')}/webhook`;
      await bot.telegram.setWebhook(webhookUrl);
      log('Webhook set to', webhookUrl);
    } else {
      await bot.launch({ dropPendingUpdates: true, allowedUpdates: ['message','callback_query'] });
      log('Polling launched');
    }
    log('Bot started');
    try { await bot.telegram.sendMessage(ADMIN, 'Net-Buy-Pumpet deployed and running. Use /start', { parse_mode:'Markdown' }); } catch (e) { warn('startup notify failed', e.message); }
  } catch (err) {
    error('startBot error', err);
    process.exit(1);
  }
}
startBot();

/* ---------- end of file ---------- */
