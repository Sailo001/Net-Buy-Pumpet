// index.js
// package.json should include: { "type": "module" }

import 'dotenv/config';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import { Telegraf, Markup } from 'telegraf';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import { createServer } from 'http';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';

const { buildSwapInstruction } = require('@raydium-io/raydium-sdk');

// --------------------- Logger helpers ---------------------
const now = () => new Date().toISOString();
const log = (...args) => console.log(`[${now()}]`, ...args);
const warn = (...args) => console.warn(`[${now()}] ⚠️`, ...args);
const error = (...args) => console.error(`[${now()}] 💥`, ...args);

// --------------------- Env & validation ---------------------
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
if (!ADMIN_CHAT_ID) throw new Error('Missing ADMIN_CHAT_ID');
if (!SOLANA_PRIVATE_KEY) throw new Error('Missing SOLANA_PRIVATE_KEY');

const ADMIN = String(ADMIN_CHAT_ID).trim();
const rpcEndpoint = SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const jitoTip = parseInt(JITO_TIP_AMOUNT || '0', 10) || 0;
const PORT_NUM = parseInt(PORT || '10000', 10);

// --------------------- Solana connection & payer ---------------------
const connection = new Connection(rpcEndpoint, 'confirmed');

let payer;
try {
  // Support JSON array or base58 encoded private key
  try {
    const parsed = JSON.parse(SOLANA_PRIVATE_KEY);
    if (Array.isArray(parsed)) {
      payer = Keypair.fromSecretKey(Uint8Array.from(parsed));
    } else {
      throw new Error('Not array');
    }
  } catch {
    payer = Keypair.fromSecretKey(bs58.decode(SOLANA_PRIVATE_KEY));
  }
  log('Main payer publicKey:', payer.publicKey.toString());
} catch (err) {
  error('Failed to parse SOLANA_PRIVATE_KEY:', err.message || err);
  throw err;
}

// --------------------- Extra wallets ---------------------
function parseExtraWalletKeys(raw) {
  if (!raw) return [];
  const out = [];
  // try JSON array
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        try {
          if (Array.isArray(item)) out.push(Keypair.fromSecretKey(Uint8Array.from(item)));
          else out.push(Keypair.fromSecretKey(bs58.decode(String(item))));
        } catch (e) {
          warn('Skipping invalid extra wallet item:', e.message || e);
        }
      }
      return out;
    }
  } catch { /* not JSON */ }

  // fallback CSV
  for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    try {
      out.push(Keypair.fromSecretKey(bs58.decode(part)));
    } catch (e) {
      warn('Skipping invalid wallet CSV key:', e.message || e);
    }
  }
  return out;
}
const extraWalletKps = parseExtraWalletKeys(WALLET_PRIVATE_KEYS || '');
log('Parsed extra wallets:', extraWalletKps.length);

// --------------------- Telegraf ---------------------
const bot = new Telegraf(TELEGRAM_BOT_TOKEN, { handlerTimeout: 120_000 });

// --------------------- State ---------------------
let running = false;
let isShuttingDown = false;

const session = {
  mint: '',
  buySol: 0,
  sellPct: 0,
  delaySec: 2,
  buyScale: 1.1,
  multiBuys: 3,
  mevProtection: true,
  multiWallet: extraWalletKps.length > 0
};

// Setup flow stored in-memory (safe checks below)
const setupFlow = {
  users: new Map(), // userId -> step
  data: new Map()   // userId -> data object
};

const SETUP_STEPS = {
  WAITING_CONTRACT: 'waiting_contract',
  WAITING_SOL_AMOUNT: 'waiting_sol_amount',
  WAITING_SELL_PCT: 'waiting_sell_pct',
  WAITING_DELAY: 'waiting_delay',
  WAITING_MULTI_BUYS: 'waiting_multi_buys',
  CONFIRMATION: 'confirmation'
};

function getCurrentStep(userId) { return setupFlow.users.get(userId); }
function setUserStep(userId, step) { setupFlow.users.set(userId, step); log('setUserStep', userId, step); }
function getUserData(userId) { if (!setupFlow.data.has(userId)) setupFlow.data.set(userId, {}); return setupFlow.data.get(userId); }
function clearUserSetup(userId) { setupFlow.users.delete(userId); setupFlow.data.delete(userId); log('clearUserSetup', userId); }

// --------------------- MEVProtection ---------------------
class MEVProtection {
  constructor() { this.mevHistory = []; this.attackPatterns = new Map(); }
  async detectMEVActivity(mint) {
    try {
      log('MEV detect start for', mint.slice(0, 8));
      const signatures = await connection.getConfirmedSignaturesForAddress2(new PublicKey(mint), { limit: 50 });
      const txDetails = await Promise.all(signatures.slice(0, 20).map(s => connection.getTransaction(s.signature, { commitment: 'confirmed' })));
      const indicators = { frontRuns: 0, sandwiches: 0, copyTrades: 0, totalTxs: txDetails.filter(Boolean).length };
      const riskScore = this.calculateMEVRisk(indicators);
      log('MEV Analysis', mint.slice(0,8), 'riskScore', riskScore.toFixed(2), 'txs', indicators.totalTxs);
      return { riskScore, indicators, recommendation: this.getProtectionRecommendation(riskScore) };
    } catch (err) {
      warn('MEV detection failed:', err.message || err);
      return { riskScore: 0.5, indicators: { totalTxs: 0 }, recommendation: 'medium' };
    }
  }
  calculateMEVRisk(indicators) {
    const total = indicators.totalTxs || 0;
    if (total === 0) return 0.5;
    return Math.min(0.8, total > 100 ? 0.7 : 0.3);
  }
  getProtectionRecommendation(score) {
    if (score < 0.3) return 'low';
    if (score < 0.7) return 'medium';
    return 'high';
  }
  splitTransaction(amount, protection = 'medium') {
    const cfg = { low: { chunks: 2, variance: 0.1 }, medium: { chunks: 3, variance: 0.2 }, high: { chunks: 5, variance: 0.3 } }[protection] || { chunks: 3, variance: 0.2 };
    const base = amount / cfg.chunks;
    const sizes = [];
    for (let i=0;i<cfg.chunks;i++){
      const rf = 1 + (Math.random()-0.5)*cfg.variance;
      sizes.push(base * rf);
    }
    const total = sizes.reduce((s,v)=>s+v,0);
    return sizes.map(s => (s/total)*amount);
  }
  generateDelays(count, protection = 'medium') {
    const cfg = { low:{min:100,max:1000}, medium:{min:200,max:2000}, high:{min:500,max:3000} }[protection] || {min:200,max:2000};
    return Array.from({length: Math.max(0,count)}, ()=> Math.floor(Math.random()*(cfg.max-cfg.min)+cfg.min));
  }
}
const mevProtection = new MEVProtection();

// --------------------- MultiWalletOrchestrator ---------------------
class MultiWalletOrchestrator {
  constructor() {
    this.wallets = [];
    this.loadWallets();
  }
  loadWallets() {
    this.wallets.push({ keypair: payer, role: 'main', active: true, balance: 0 });
    extraWalletKps.forEach((kp, idx) => this.wallets.push({ keypair: kp, role: `wallet_${idx+1}`, active: true, balance: 0 }));
    log('Multi-wallet loaded:', this.wallets.length);
  }
  getActiveWallets() { return this.wallets.filter(w => w.active); }
  distributeAmount(totalAmount, walletCount = null) {
    const active = this.getActiveWallets();
    const use = walletCount || Math.min(active.length, 3);
    if (use === 0) return [];
    const out = [];
    let remaining = totalAmount;
    for (let i=0;i<use-1;i++){
      const pct = 0.2 + Math.random()*0.2;
      const amt = +(remaining * pct).toFixed(8);
      out.push(amt);
      remaining -= amt;
    }
    out.push(+remaining.toFixed(8));
    // shuffle
    for (let i=out.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [out[i],out[j]]=[out[j],out[i]]; }
    return out;
  }
  generateNaturalDelays(count) {
    if (count <= 0) return [];
    const arr = [];
    for (let i=0;i<count;i++){
      const base = 500 + Math.random()*7500;
      const cluster = Math.random() < 0.3 ? Math.random()*2000 : 0;
      arr.push(Math.floor(base + cluster));
    }
    return arr;
  }

  async executeCoordinatedBuy(mint, totalAmount, protection=true) {
    const active = this.getActiveWallets();
    const use = Math.min(active.length, 3);
    if (use <= 0) throw new Error('No active wallets');
    const amounts = this.distributeAmount(totalAmount, use);
    const delays = this.generateNaturalDelays(use-1);
    const results = [];
    for (let i=0;i<use;i++){
      const w = active[i];
      const amt = amounts[i];
      try {
        log('executeCoordinatedBuy wallet', w.role, amt);
        const tx = await this.executeBuyWithWallet(w, mint, amt, protection);
        results.push({ wallet: w.role, amount: amt, tx });
        log('wallet buy success', w.role, tx);
      } catch (err) {
        warn('wallet buy failed', w.role, err.message || err);
        results.push({ wallet: w.role, amount: amt, error: err.message || String(err) });
      }
      if (i < delays.length) await new Promise(r => setTimeout(r, delays[i]));
    }
    return results;
  }

  async executeBuyWithWallet(walletObj, mint, solAmount, mevProtectionFlag = true) {
    const pool = await getRaydiumPoolInfo(mint);
    const buyingBase = (pool.baseMint === mint);
    const WSOL = 'So11111111111111111111111111111111111111112';
    const wallet = walletObj.keypair;

    const userWSOL = await getAssociatedTokenAddress(new PublicKey(WSOL), wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const amountIn = Math.floor(solAmount * LAMPORTS_PER_SOL);

    const wsolInfo = await connection.getAccountInfo(userWSOL);
    if (!wsolInfo) {
      const createTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(wallet.publicKey, userWSOL, wallet.publicKey, new PublicKey(WSOL), TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
      );
      await connection.sendTransaction(createTx, [wallet]);
    }

    const wrapTx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: userWSOL, lamports: amountIn }),
      createSyncNativeInstruction(userWSOL)
    );

    if (mevProtectionFlag) await sendPrivateTransactionWithWallet(wrapTx, wallet);
    else await connection.sendTransaction(wrapTx, [wallet]);

    const toMint = buyingBase ? mint : WSOL;
    const userOutATA = await getAssociatedTokenAddress(new PublicKey(toMint), wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const outInfo = await connection.getAccountInfo(userOutATA);
    if (!outInfo) {
      const createOutTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(wallet.publicKey, userOutATA, wallet.publicKey, new PublicKey(toMint), TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
      );
      await connection.sendTransaction(createOutTx, [wallet]);
    }

    const swapIx = await buildSwapInstruction({
      poolKeys: pool,
      userKeys: { tokenAccountIn: userWSOL, tokenAccountOut: userOutATA, owner: wallet.publicKey, payer: wallet.publicKey },
      amountIn,
      minAmountOut: 1,
      direction: buyingBase ? 'quote2base' : 'base2quote'
    });

    const swapTx = new Transaction();
    if (swapIx?.innerTransactions) swapIx.innerTransactions.forEach(t => (t.instructions||[]).forEach(ix=>swapTx.add(ix)));
    else if (swapIx?.instructions) swapIx.instructions.forEach(ix=>swapTx.add(ix));
    else if (Array.isArray(swapIx)) swapIx.forEach(ix=>swapTx.add(ix));

    if (mevProtectionFlag) return await sendPrivateTransactionWithWallet(swapTx, wallet);
    return await connection.sendTransaction(swapTx, [wallet]);
  }
}
const multiWallet = new MultiWalletOrchestrator();

// --------------------- fetchWithTimeout & pool lookup ---------------------
async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function getRaydiumPoolInfo(mintAddress, retries = 3) {
  if (!mintAddress) throw new Error('mintAddress required');
  const raydiumUrl = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
  const solscanMetaUrl = `https://public-api.solscan.io/token/meta?tokenAddress=${mintAddress}`;

  // Try Raydium with retries
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(raydiumUrl, {}, 10000);
      if (!res.ok) throw new Error(`Raydium HTTP ${res.status}`);
      const pools = await res.json();
      for (const sid in pools.official) {
        const pool = pools.official[sid];
        if (pool.baseMint === mintAddress || pool.quoteMint === mintAddress) {
          pool.id = sid;
          log('Found Raydium pool (official)', sid);
          return pool;
        }
      }
      for (const sid in pools.unOfficial) {
        const pool = pools.unOfficial[sid];
        if (pool.baseMint === mintAddress || pool.quoteMint === mintAddress) {
          pool.id = sid;
          log('Found Raydium pool (unofficial)', sid);
          return pool;
        }
      }
      throw new Error('No Raydium pool found for mint: ' + mintAddress);
    } catch (err) {
      warn(`getRaydiumPoolInfo attempt ${attempt} failed:`, err.message || err);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      warn('Raydium failed after retries; attempting Solscan fallback');
    }
  }

  // Solscan fallback (token meta)
  try {
    const r = await fetchWithTimeout(solscanMetaUrl, {}, 8000);
    if (!r.ok) throw new Error(`Solscan HTTP ${r.status}`);
    const meta = await r.json();
    if (meta) {
      log('Solscan fallback found meta', meta.symbol || '', mintAddress);
      // Return a minimal pool-like object: quoteMint WSOL so downstream swap code can proceed (may fail if no pool exists)
      return { id: mintAddress, baseMint: mintAddress, quoteMint: 'So11111111111111111111111111111111111111112', source: 'solscan' };
    }
    throw new Error('No Solscan meta');
  } catch (err) {
    error('Solscan fallback failed:', err.message || err);
    throw new Error('Pool lookup failed for ' + mintAddress);
  }
}

// --------------------- ATA helpers ---------------------
async function getATA(mint, owner) {
  return await getAssociatedTokenAddress(new PublicKey(mint), owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}
async function ensureATA(mint, owner) {
  const ata = await getATA(mint, owner);
  const info = await connection.getAccountInfo(ata);
  if (!info) {
    log('Creating ATA for', mint.slice(0,8), 'owner', owner.toString().slice(0,8));
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, new PublicKey(mint), TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
    );
    await connection.sendTransaction(tx, [payer]);
  }
  return ata;
}

// --------------------- Transaction senders (Jito fallback) ---------------------
async function sendPrivateTransaction(transaction, tip = jitoTip || 10000) {
  try {
    if (tip > 0) {
      transaction.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'), lamports: tip }));
    }
    const jitoEndpoint = MEV_CONFIG.privatePools[Math.floor(Math.random() * MEV_CONFIG.privatePools.length)];
    try {
      const payload = { jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [ transaction.serialize({ requireAllSignatures: false }).toString('base64'), { skipPreflight: false, preflightCommitment: 'confirmed' } ] };
      const resp = await fetchWithTimeout(`${jitoEndpoint}/api/v1/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 8000);
      const json = await resp.json();
      if (json?.result) { log('Jito send result', json.result); return json.result; }
    } catch (jitoErr) {
      warn('Jito send failed, falling back to public RPC', jitoErr.message || jitoErr);
    }
    const sig = await connection.sendTransaction(transaction, [payer], { skipPreflight: false, preflightCommitment: 'confirmed' });
    log('Public RPC tx sig', sig);
    return sig;
  } catch (err) {
    error('sendPrivateTransaction failed', err);
    throw err;
  }
}

async function sendPrivateTransactionWithWallet(transaction, wallet, tip = jitoTip || 10000) {
  try {
    if (tip > 0) {
      transaction.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'), lamports: tip }));
    }
    const jitoEndpoint = MEV_CONFIG.privatePools[Math.floor(Math.random() * MEV_CONFIG.privatePools.length)];
    try {
      const payload = { jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [ transaction.serialize({ requireAllSignatures: false }).toString('base64'), { skipPreflight: false, preflightCommitment: 'confirmed' } ] };
      const resp = await fetchWithTimeout(`${jitoEndpoint}/api/v1/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 8000);
      const json = await resp.json();
      if (json?.result) { log('Jito wallet send result', json.result); return json.result; }
    } catch (jitoErr) {
      warn('Jito wallet send failed, using public RPC', jitoErr.message || jitoErr);
    }
    const sig = await connection.sendTransaction(transaction, [wallet], { skipPreflight: false, preflightCommitment: 'confirmed' });
    log('Wallet public RPC tx sig', sig);
    return sig;
  } catch (err) {
    error('sendPrivateTransactionWithWallet failed', err);
    throw err;
  }
}

// --------------------- Buy / Sell wrappers ---------------------
async function buyTokenSingle(mint, solAmount) {
  log('buyTokenSingle', mint.slice(0,8), solAmount);
  const pool = await getRaydiumPoolInfo(mint);
  const buyingBase = (pool.baseMint === mint);
  const WSOL = 'So11111111111111111111111111111111111111112';
  const userWSOL = await ensureATA(WSOL, payer.publicKey);
  const amountIn = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const rawBalance = await connection.getTokenAccountBalance(userWSOL).catch(()=>null);
  const wsolBalance = Number(rawBalance?.value?.amount || 0);
  if (wsolBalance < amountIn) {
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: userWSOL, lamports: amountIn }),
      createSyncNativeInstruction(userWSOL)
    );
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
  log('buyTokenMEVProtected', mint.slice(0,8), solAmount);
  const analysis = await mevProtection.detectMEVActivity(mint);
  const protection = analysis.recommendation || 'medium';
  const chunks = mevProtection.splitTransaction(solAmount, protection);
  const delays = mevProtection.generateDelays(Math.max(0, chunks.length-1), protection);
  const results = [];
  for (let i=0;i<chunks.length;i++){
    try {
      const tx = await buyTokenSingle(mint, chunks[i]);
      results.push(tx);
      log('chunk buy success', tx);
    } catch (err) {
      warn('chunk buy failed', err.message || err);
      results.push({ error: err.message || String(err) });
    }
    if (i < delays.length) await new Promise(r => setTimeout(r, delays[i]));
  }
  return results;
}

async function sellTokenSingle(mint, sellPct) {
  log('sellTokenSingle', mint.slice(0,8), sellPct);
  const pool = await getRaydiumPoolInfo(mint);
  const baseMint = pool.baseMint;
  const WSOL = 'So11111111111111111111111111111111111111112';
  const userBaseATA = await ensureATA(baseMint, payer.publicKey);
  const userWSOL = await ensureATA(WSOL, payer.publicKey);
  const rawBal = await connection.getTokenAccountBalance(userBaseATA);
  const bal = Number(rawBal?.value?.amount || 0);
  const amountIn = Math.floor(bal * (sellPct / 100));
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
  log('sellTokenMEVProtected', mint.slice(0,8), sellPct);
  const analysis = await mevProtection.detectMEVActivity(mint);
  const protection = analysis.recommendation || 'medium';
  if (sellPct === 100 || protection === 'high') {
    return [await sellTokenSingle(mint, sellPct)];
  }
  const chunks = Math.min(3, Math.ceil(sellPct / 25));
  const chunkPct = sellPct / chunks;
  const delays = mevProtection.generateDelays(Math.max(0, chunks-1), protection);
  const results = [];
  for (let i=0;i<chunks;i++){
    try { const tx = await sellTokenSingle(mint, chunkPct); results.push(tx); } catch (err) { warn('sell chunk failed', err.message || err); results.push({ error: err.message || String(err) }); }
    if (i < delays.length) await new Promise(r => setTimeout(r, delays[i]));
  }
  return results;
}

// --------------------- Menus ---------------------
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
function getAdvancedMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🛡️ Toggle MEV Protection', 'toggle_mev')],
    [Markup.button.callback('🎭 Toggle Multi-Wallet', 'toggle_multiwallet')],
    [Markup.button.callback('🔍 MEV Analysis', 'analyze_mev')],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')]
  ]);
}
function getSetupMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel Setup', 'cancel_setup')],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')]
  ]);
}
function getStatusMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⚙️ New Setup', 'start_setup')],
    [Markup.button.callback('🔥 Start Pump', 'start_pump')],
    [Markup.button.callback('💰 Sell All', 'sell_all_confirm')],
    [Markup.button.callback('🛡️ Advanced Settings', 'advanced_menu')],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')]
  ]);
}

function showCurrentConfig() {
  return [
    '📊 **Current Configuration:**',
    '',
    `🎯 **Token:** ${session.mint || 'Not set'}`,
    `💰 **Buy Amount:** ${session.buySol} SOL`,
    `📈 **Sell Percentage:** ${session.sellPct}%`,
    `⏱️ **Delay:** ${session.delaySec} seconds`,
    `🔄 **Multi-Buys:** ${session.multiBuys} per cycle`,
    `📈 **Buy Scaling:** ${session.buyScale}x`,
    '',
    '🛡️ **Advanced Features:**',
    `🛡️ MEV Protection: ${session.mevProtection ? '🟢 ON' : '🔴 OFF'}`,
    `🎭 Multi-Wallet: ${session.multiWallet ? '🟢 ON' : '🔴 OFF'}`,
    `🎭 Available Wallets: ${multiWallet.getActiveWallets().length}`
  ].join('\n');
}

function getSetupSummary(userData) {
  return [
    '📋 **Setup Summary:**',
    '',
    `🎯 **Token Contract:** ${userData.mint || 'Not set'}`,
    `💰 **Buy Amount:** ${userData.buySol || 'Not set'} SOL`,
    `📈 **Sell Percentage:** ${userData.sellPct || 'Not set'}%`,
    `⏱️ **Delay:** ${userData.delaySec || 'Not set'} seconds`,
    `🔄 **Multi-Buys:** ${userData.multiBuys || 'Not set'} per cycle`
  ].join('\n');
}

// --------------------- Telegram handlers ---------------------
bot.start(async ctx => {
  log('/start by', ctx.from.id, ctx.from.username || '');
  if (String(ctx.from.id) !== ADMIN) return;
  const welcome = [
    '🤖 **Welcome to Net-Buy-Pumpet!**',
    '',
    `🎯 Token: ${session.mint ? `${session.mint.slice(0,8)}...` : '❌ Not configured'}`,
    `🔄 Bot: ${running ? '🟢 Active' : '🔴 Stopped'}`,
    `🎭 Wallets: ${multiWallet.getActiveWallets().length} loaded`,
    '',
    '👇 Choose an action:'
  ].join('\n');
  ctx.reply(welcome, { ...getMainMenu(), parse_mode: 'Markdown' });
});

bot.command('setup', ctx => {
  if (String(ctx.from.id) !== ADMIN) return;
  clearUserSetup(ctx.from.id);
  setUserStep(ctx.from.id, SETUP_STEPS.WAITING_CONTRACT);
  ctx.reply('🔧 Pump Setup - Step 1/5\n\nSend token mint address', { ...getSetupMenu(), parse_mode: 'Markdown' });
});

bot.command('status', ctx => {
  if (String(ctx.from.id) !== ADMIN) return;
  ctx.reply(showCurrentConfig(), { ...getStatusMenu(), parse_mode: 'Markdown' });
});

bot.command('advanced', ctx => {
  if (String(ctx.from.id) !== ADMIN) return;
  ctx.reply('🛡️ Advanced Features', { ...getAdvancedMenu(), parse_mode: 'Markdown' });
});

bot.command('help', ctx => {
  if (String(ctx.from.id) !== ADMIN) return;
  ctx.reply('Use the menu to configure and run the pump. /setup to start configuration', { ...getMainMenu(), parse_mode: 'Markdown' });
});

// Text handler with stronger validation & safe fallback
bot.on('text', async ctx => {
  if (String(ctx.from.id) !== ADMIN) return;
  const userId = ctx.from.id;
  const currentStep = getCurrentStep(userId);
  const text = (ctx.message.text || '').trim();
  log('text from', userId, 'step', currentStep || 'undefined', text.slice(0,80));

  // If no current step, guide the user to start setup
  if (!currentStep) {
    await ctx.reply('❗ No active setup. Use the "Setup Configuration" button or send /setup to begin.', getMainMenu());
    return;
  }

  const userData = getUserData(userId);

  try {
    switch (currentStep) {
      case SETUP_STEPS.WAITING_CONTRACT:
        if (!text || text.length < 32 || text.length > 64) {
          return ctx.reply('❌ Invalid contract address. Please enter a valid Solana token mint address.', getSetupMenu());
        }
        try {
          const pool = await getRaydiumPoolInfo(text);
          userData.mint = text;
          setUserStep(userId, SETUP_STEPS.WAITING_SOL_AMOUNT);
          await ctx.reply('✅ Token Found! Enter SOL amount per buy (e.g., 0.1)', getSetupMenu());
          log('Setup Step 1 success', userId, text.slice(0,8), 'poolId', pool.id || 'n/a');
        } catch (err) {
          warn('mint validation failed:', err.message || err);
          return ctx.reply(`❌ Token not found or API error: ${err.message || err}`, getSetupMenu());
        }
        break;

      case SETUP_STEPS.WAITING_SOL_AMOUNT:
        {
          const val = parseFloat(text);
          if (isNaN(val) || val <= 0 || val > 1000) return ctx.reply('❌ Enter a number between 0.001 and 1000', getSetupMenu());
          userData.buySol = val;
          setUserStep(userId, SETUP_STEPS.WAITING_SELL_PCT);
          await ctx.reply('✅ SOL amount set. Enter sell percentage (0-100)', getSetupMenu());
        }
        break;

      case SETUP_STEPS.WAITING_SELL_PCT:
        {
          const val = parseInt(text, 10);
          if (isNaN(val) || val < 0 || val > 100) return ctx.reply('❌ Enter integer 0-100', getSetupMenu());
          userData.sellPct = val;
          setUserStep(userId, SETUP_STEPS.WAITING_DELAY);
          await ctx.reply('✅ Sell % set. Enter delay between rounds (seconds)', getSetupMenu());
        }
        break;

      case SETUP_STEPS.WAITING_DELAY:
        {
          const val = parseInt(text, 10);
          if (isNaN(val) || val < 1 || val > 86400) return ctx.reply('❌ Enter integer seconds between 1 and 86400', getSetupMenu());
          userData.delaySec = val;
          setUserStep(userId, SETUP_STEPS.WAITING_MULTI_BUYS);
          await ctx.reply('✅ Delay set. Enter multi-buys per cycle (1-10)', getSetupMenu());
        }
        break;

      case SETUP_STEPS.WAITING_MULTI_BUYS:
        {
          const val = parseInt(text, 10);
          if (isNaN(val) || val < 1 || val > 10) return ctx.reply('❌ Enter integer 1-10', getSetupMenu());
          userData.multiBuys = val;
          setUserStep(userId, SETUP_STEPS.CONFIRMATION);

          const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm & Save', 'confirm_setup')],
            [Markup.button.callback('❌ Cancel Setup', 'cancel_setup')],
            [Markup.button.callback('🔄 Start Over', 'start_setup')],
            [Markup.button.callback('🏠 Main Menu', 'main_menu')]
          ]);
          await ctx.reply('🎉 Setup complete!\n\n' + getSetupSummary(userData), { ...keyboard, parse_mode: 'Markdown' });
        }
        break;

      default:
        warn('Unknown setup step', currentStep);
        await ctx.reply('❌ Unknown setup step. Please restart setup with /setup or the Setup button.', getSetupMenu());
        clearUserSetup(userId);
    }
  } catch (err) {
    error('text handler error', err);
    await ctx.reply('❌ Error during setup: ' + (err.message || err), getSetupMenu());
    clearUserSetup(userId);
  }
});

// safeEdit utility (avoid "message is not modified")
async function safeEdit(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra });
  } catch (err) {
    if (err.description && err.description.includes('message is not modified')) {
      log('safeEdit skipped duplicate');
    } else {
      error('safeEdit error', err);
    }
  }
}

// --------------------- callback_query handlers ---------------------
bot.on('callback_query', async ctx => {
  const uid = String(ctx.from.id);
  const action = ctx.callbackQuery?.data;
  log('callback_query', uid, action);
  if (uid !== ADMIN) { try { await ctx.answerCbQuery('Unauthorized'); } catch(_){}; return; }

  try {
    switch (action) {
      case 'main_menu':
        await safeEdit(ctx, '🤖 Net-Buy-Pumpet Dashboard\n\n' + showCurrentConfig(), getMainMenu());
        break;

      case 'start_setup':
        clearUserSetup(uid);
        setUserStep(uid, SETUP_STEPS.WAITING_CONTRACT);
        await ctx.reply('🔧 Pump Setup - Step 1/5\n\nSend token mint address', getSetupMenu());
        break;

      case 'confirm_setup': {
        const ud = getUserData(uid);
        if (!ud.mint) { await ctx.answerCbQuery('No setup data'); break; }
        session.mint = ud.mint;
        session.buySol = ud.buySol;
        session.sellPct = ud.sellPct;
        session.delaySec = ud.delaySec;
        session.multiBuys = ud.multiBuys;
        clearUserSetup(uid);
        await safeEdit(ctx, '🎉 Configuration Saved!\n\n' + showCurrentConfig(), getMainMenu());
        break;
      }

      case 'cancel_setup':
        clearUserSetup(uid);
        await safeEdit(ctx, '❌ Setup cancelled', getMainMenu());
        break;

      case 'refresh_status':
        await safeEdit(ctx, showCurrentConfig(), getStatusMenu());
        break;

      case 'start_pump':
        if (running) { await ctx.answerCbQuery('Pump already running'); return; }
        if (!session.mint || !session.buySol) { await ctx.answerCbQuery('Complete setup first'); return; }
        running = true;
        await safeEdit(ctx, '🔥 Pump started\n\n' + showCurrentConfig(), getStatusMenu());
        startPumpLoop().catch(err => { error('pump loop failed', err); running = false; });
        break;

      case 'stop_pump':
        if (!running) { await ctx.answerCbQuery('Pump not running'); return; }
        running = false;
        await safeEdit(ctx, '⏹️ Pump stop requested', getMainMenu());
        break;

      case 'sell_all_confirm':
        if (!session.mint) { await ctx.answerCbQuery('No token set'); return; }
        await ctx.reply('🚨 Confirm SELL ALL?', Markup.inlineKeyboard([[Markup.button.callback('🚨 YES, SELL ALL', 'sell_all_execute')],[Markup.button.callback('❌ Cancel', 'main_menu')]]));
        break;

      case 'sell_all_execute':
        try {
          await ctx.reply('⏳ Selling all tokens...');
          const results = session.mevProtection ? await sellTokenMEVProtected(session.mint, 100) : [await sellTokenSingle(session.mint, 100)];
          await ctx.reply('✅ Sell results:\n' + JSON.stringify(results, null, 2), getMainMenu());
        } catch (err) {
          error('sell_all_execute failed', err);
          await ctx.reply('❌ Sell failed: ' + (err.message || err));
        }
        break;

      case 'multiwallet_status': {
        const wallets = multiWallet.getActiveWallets();
        const lines = ['🎭 Multiwallet status:', '', `Total: ${wallets.length}`, ...wallets.map((w,i)=>`${i+1}. ${w.role} ${w.keypair.publicKey.toString().slice(0,8)}...`) ];
        await safeEdit(ctx, lines.join('\n'), getAdvancedMenu());
        break;
      }

      case 'advanced_menu':
        await safeEdit(ctx, '🛡️ Advanced', getAdvancedMenu());
        break;

      case 'toggle_mev':
        session.mevProtection = !session.mevProtection;
        await safeEdit(ctx, `🛡️ MEV Protection ${session.mevProtection ? 'ENABLED' : 'DISABLED'}`, getAdvancedMenu());
        break;

      case 'toggle_multiwallet':
        if (multiWallet.getActiveWallets().length < 2) { await ctx.answerCbQuery('Need multiple wallets'); return; }
        session.multiWallet = !session.multiWallet;
        await safeEdit(ctx, `🎭 Multi-Wallet ${session.multiWallet ? 'ENABLED' : 'DISABLED'}`, getAdvancedMenu());
        break;

      case 'analyze_mev':
        if (!session.mint) { await ctx.answerCbQuery('Set token first'); return; }
        await ctx.reply('🔍 Analyzing MEV activity...');
        try {
          const analysis = await mevProtection.detectMEVActivity(session.mint);
          await ctx.reply(`🔍 Risk ${analysis.riskScore.toFixed(2)} - ${analysis.recommendation.toUpperCase()}`, getAdvancedMenu());
        } catch (err) {
          await ctx.reply('❌ MEV analysis failed: ' + (err.message || err), getAdvancedMenu());
        }
        break;

      default:
        warn('Unknown callback action', action);
        await ctx.answerCbQuery('Unknown action');
    }
    try { await ctx.answerCbQuery(); } catch (_) {}
  } catch (err) {
    error('callback handler error', err);
    try { await ctx.answerCbQuery('Error'); } catch (_) {}
  }
});

// generic messages fallback
bot.on('message', ctx => {
  if (String(ctx.from.id) !== ADMIN) return;
  const step = getCurrentStep(ctx.from.id);
  if (!step && ctx.message.text && !ctx.message.text.startsWith('/')) {
    ctx.reply('❗ No active setup — press "Setup Configuration" or run /setup', getMainMenu());
  }
});

// bot.catch
bot.catch((err, ctx) => {
  error('Bot error', err);
  if (err.code === 409 || err.response?.error_code === 409) {
    warn('Bot conflict (409) - shut down this instance');
    gracefulShutdown();
    return;
  }
  if (ctx) {
    try { ctx.reply('❌ Bot error: ' + (err.message || err)); } catch (e) { error('Failed to send error message', e); }
  }
});

// --------------------- Pump loop ---------------------
async function startPumpLoop() {
  if (!session.mint) throw new Error('No token configured');
  let buyAmount = session.buySol;
  let cycle = 0;
  const initialMev = await mevProtection.detectMEVActivity(session.mint);
  try {
    await bot.telegram.sendMessage(ADMIN, `🛡️ MEV Analysis: ${initialMev.riskScore.toFixed(2)} (${initialMev.recommendation})`, { parse_mode: 'Markdown' });
  } catch (e) { warn('Notify admin failed', e.message || e); }

  while (running && !isShuttingDown) {
    cycle++;
    log('Pump cycle', cycle, 'buyAmount', buyAmount);
    try {
      await bot.telegram.sendMessage(ADMIN, `🔄 Cycle ${cycle} starting - ${buyAmount.toFixed(4)} SOL`, { parse_mode: 'Markdown' });

      for (let i=0;i<session.multiBuys;i++){
        if (!running || isShuttingDown) break;
        try {
          if (session.multiWallet && multiWallet.getActiveWallets().length > 1) {
            const results = await multiWallet.executeCoordinatedBuy(session.mint, buyAmount, session.mevProtection);
            await bot.telegram.sendMessage(ADMIN, `✅ Coordinated buys:\n${JSON.stringify(results)}`, { parse_mode: 'Markdown' });
          } else if (session.mevProtection) {
            const r = await buyTokenMEVProtected(session.mint, buyAmount);
            await bot.telegram.sendMessage(ADMIN, `✅ Protected buy results:\n${JSON.stringify(r)}`, { parse_mode: 'Markdown' });
          } else {
            const tx = await buyTokenSingle(session.mint, buyAmount);
            await bot.telegram.sendMessage(ADMIN, `✅ Buy tx: ${tx}`, { parse_mode: 'Markdown' });
          }
        } catch (err) {
          warn('Buy error', err.message || err);
          await bot.telegram.sendMessage(ADMIN, `❌ Buy failed: ${err.message || err}`, { parse_mode: 'Markdown' });
        }
        if (i < session.multiBuys - 1) await new Promise(r => setTimeout(r, 1000));
      }

      if (session.sellPct > 0 && running && !isShuttingDown) {
        try {
          const sellRes = session.mevProtection ? await sellTokenMEVProtected(session.mint, session.sellPct) : await sellTokenSingle(session.mint, session.sellPct);
          await bot.telegram.sendMessage(ADMIN, `📈 Sell results:\n${JSON.stringify(sellRes)}`, { parse_mode: 'Markdown' });
        } catch (err) {
          warn('Sell failed', err.message || err);
          await bot.telegram.sendMessage(ADMIN, `❌ Sell failed: ${err.message || err}`, { parse_mode: 'Markdown' });
        }
      }

      buyAmount *= session.buyScale;
      const baseDelayMs = (session.delaySec || 1) * 1000;
      const jitter = 0.8 + Math.random()*0.4;
      const mevDelay = initialMev.riskScore > 0.7 ? 2000 : 0;
      const delayMs = Math.max(500, baseDelayMs * jitter + mevDelay);
      log('Cycle complete - sleeping', Math.round(delayMs));
      await new Promise(r => setTimeout(r, delayMs));
    } catch (err) {
      error('Cycle error', err);
      await bot.telegram.sendMessage(ADMIN, `❌ Cycle ${cycle} error: ${err.message || err}`, { parse_mode: 'Markdown' });
    }
  }

  await bot.telegram.sendMessage(ADMIN, '⏹️ Pump stopped', { parse_mode: 'Markdown' });
  log('Pump loop ended');
}

// --------------------- Graceful shutdown ---------------------
async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  running = false;
  log('Graceful shutdown initiated');
  try { await bot.telegram.sendMessage(ADMIN, '🛑 Bot shutting down...'); } catch (e) { warn('Notify admin failed', e.message || e); }
  try { await bot.stop(); log('Bot stopped'); } catch (e) { error('bot.stop error', e); }
  setTimeout(()=> { log('Process exit'); process.exit(0); }, 2000);
}
process.once('SIGINT', ()=> { log('SIGINT'); gracefulShutdown(); });
process.once('SIGTERM', ()=> { log('SIGTERM'); gracefulShutdown(); });
process.on('uncaughtException', (err)=> { error('uncaughtException', err); gracefulShutdown(); });
process.on('unhandledRejection', (reason,promise)=> { error('unhandledRejection', reason, promise); });

// --------------------- Health / webhook server ---------------------
const server = createServer((req,res) => {
  if (req.url === '/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const update = JSON.parse(body);
        await bot.handleUpdate(update);
        res.writeHead(200, {'Content-Type':'text/plain'}); res.end('OK');
      } catch (err) {
        error('Webhook processing error', err);
        if (!res.headersSent) { res.writeHead(400, {'Content-Type':'text/plain'}); res.end('Bad Request'); }
      }
    });
    return;
  }

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({
      status: 'healthy',
      bot_running: !isShuttingDown,
      pump_active: running,
      configured: !!session.mint,
      mev_protection: session.mevProtection,
      multi_wallet: session.multiWallet,
      wallet_count: multiWallet.getActiveWallets().length,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  res.writeHead(404, {'Content-Type':'text/plain'}); res.end('Not Found');
});

server.listen(PORT_NUM, ()=> log('Health server listening on', PORT_NUM));

// --------------------- Start bot (webhook or polling) ---------------------
async function startBot() {
  try {
    const useWebhooks = NODE_ENV === 'production' && !!RENDER_EXTERNAL_URL;
    if (useWebhooks) {
      const webhookUrl = `${RENDER_EXTERNAL_URL.replace(/\/$/, '')}/webhook`;
      await bot.telegram.setWebhook(webhookUrl);
      log('Webhook set to', webhookUrl);
    } else {
      await bot.launch({ dropPendingUpdates: true, allowedUpdates: ['message','callback_query'] });
      log('Using polling mode');
    }
    log('Bot running, wallets loaded:', multiWallet.getActiveWallets().length);
    try {
      await bot.telegram.sendMessage(ADMIN, '🤖 Net-Buy-Pumpet deployed and running! Send /start', { parse_mode: 'Markdown' });
      log('Startup message sent to admin');
    } catch (e) { warn('Failed to send startup msg', e.message || e); }
  } catch (err) {
    error('Failed to start bot', err);
    if (err.code === 409 || err.response?.error_code === 409) warn('Another bot instance might be running (409)');
    process.exit(1);
  }
}
startBot();
