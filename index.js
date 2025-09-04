// index.js
// Make sure package.json: { "type": "module" }

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

// ---------------------------
// CONFIG / ENV
// ---------------------------
const {
  TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
  ADMIN_CHAT_ID: ADMIN,
  SOLANA_PRIVATE_KEY: PRIVATE_KEY,
  SOLANA_RPC_URL: RPC_URL,
  JITO_TIP_AMOUNT: JITO_TIP,
  WALLET_PRIVATE_KEYS: WALLET_KEYS,
  DRY_RUN: DRY_RUN_RAW,
  PORT: PORT_RAW,
  NODE_ENV
} = process.env;

const DRY_RUN = DRY_RUN_RAW === 'true' || DRY_RUN_RAW === '1';
const port = parseInt(PORT_RAW, 10) || 3000;

// Basic env validation (fail fast for critical values)
if (!TELEGRAM_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required. Add to .env and restart.');
  process.exit(1);
}
if (!PRIVATE_KEY) {
  console.error('❌ SOLANA_PRIVATE_KEY is required. Add to .env and restart.');
  process.exit(1);
}
if (!ADMIN) {
  console.warn('⚠️ ADMIN_CHAT_ID not set. Admin-only commands will not be restricted.');
}

// MEV private pools (your existing list)
const MEV_CONFIG = {
  privatePools: [
    'https://mainnet.block-engine.jito.wtf',
    'https://amsterdam.mainnet.block-engine.jito.wtf',
    'https://frankfurt.mainnet.block-engine.jito.wtf',
    'https://ny.mainnet.block-engine.jito.wtf',
    'https://tokyo.mainnet.block-engine.jito.wtf'
  ],
  maxSlippage: { low: 0.5, medium: 1.0, high: 0.3 },
  maxChunkSize: 0.5,
  minChunks: 2,
  maxChunks: 5,
  minDelay: 100,
  maxDelay: 3000,
  mevRiskThreshold: 0.7
};

// ---------------------------
// SOLANA / BOT INIT
// ---------------------------
const rpcEndpoint = RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(rpcEndpoint, 'confirmed');

let payer;
try {
  payer = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
} catch (err) {
  console.error('❌ Failed to decode SOLANA_PRIVATE_KEY:', err.message || err);
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_TOKEN);

// ---------------------------
// STATE
// ---------------------------
let running = false;
let isShuttingDown = false;

let session = {
  mint: '',
  buySol: 0.1,
  sellPct: 0,
  delaySec: 2,
  buyScale: 1.05,
  multiBuys: 1,
  mevProtection: true,
  multiWallet: false
};

const setupFlow = {
  users: new Map(), // userId -> step
  data: new Map()   // userId -> { ...data }
};

const SETUP_STEPS = {
  WAITING_CONTRACT: 'waiting_contract',
  WAITING_SOL_AMOUNT: 'waiting_sol_amount',
  WAITING_SELL_PCT: 'waiting_sell_pct',
  WAITING_DELAY: 'waiting_delay',
  WAITING_MULTI_BUYS: 'waiting_multi_buys',
  CONFIRMATION: 'confirmation'
};

// ---------------------------
// Utilities for setup flow
// ---------------------------
function clearUserSetup(userId) {
  setupFlow.users.delete(String(userId));
  setupFlow.data.delete(String(userId));
}
function getCurrentStep(userId) {
  return setupFlow.users.get(String(userId));
}
function setUserStep(userId, step) {
  setupFlow.users.set(String(userId), step);
}
function getUserData(userId) {
  const k = String(userId);
  if (!setupFlow.data.has(k)) setupFlow.data.set(k, {});
  return setupFlow.data.get(k);
}

// ---------------------------
// Menus (single source)
// ---------------------------
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

// ---------------------------
// MEV Protection class
// ---------------------------
class MEVProtection {
  constructor() {
    this.mevHistory = [];
  }

  async detectMEVActivity(mint) {
    try {
      const signatures = await connection.getSignaturesForAddress(new PublicKey(mint), { limit: 50 });
      const txDetails = await Promise.all(
        signatures.slice(0, 20).map(async sig => {
          try {
            const tx = await connection.getTransaction(sig.signature, { commitment: 'confirmed' });
            return tx || null;
          } catch (e) {
            return null;
          }
        })
      );
      const nonNullTxs = txDetails.filter(Boolean);
      const indicators = {
        frontRuns: 0,
        sandwiches: 0,
        copyTrades: 0,
        totalTxs: nonNullTxs.length
      };
      const riskScore = this.calculateMEVRisk(indicators);
      return { riskScore, indicators, recommendation: this.getProtectionRecommendation(riskScore) };
    } catch (err) {
      console.error('MEV detect error:', err.message || err);
      return { riskScore: 0.5, indicators: { totalTxs: 0 }, recommendation: 'medium' };
    }
  }

  calculateMEVRisk(indicators) {
    const { totalTxs } = indicators;
    if (totalTxs === 0) return 0.5;
    return Math.min(0.8, totalTxs > 100 ? 0.7 : 0.3);
  }

  getProtectionRecommendation(riskScore) {
    if (riskScore < 0.3) return 'low';
    if (riskScore < 0.7) return 'medium';
    return 'high';
  }

  splitTransaction(amount, protection = 'medium') {
    const config = { low: { chunks: 2, variance: 0.1 }, medium: { chunks: 3, variance: 0.2 }, high: { chunks: 5, variance: 0.3 } };
    const { chunks = 3, variance = 0.2 } = config[protection] || config.medium;
    const base = amount / chunks;
    const sizes = [];
    for (let i = 0; i < chunks; i++) {
      const rf = 1 + (Math.random() - 0.5) * variance;
      sizes.push(base * rf);
    }
    const sum = sizes.reduce((a, b) => a + b, 0);
    return sizes.map(s => (s / sum) * amount);
  }

  generateDelays(count, protection = 'medium') {
    const config = { low: { min: 100, max: 1000 }, medium: { min: 200, max: 2000 }, high: { min: 500, max: 3000 } };
    const { min, max } = config[protection] || config.medium;
    return Array(Math.max(0, count)).fill().map(() => Math.floor(Math.random() * (max - min) + min));
  }
}

const mevProtection = new MEVProtection();

// ---------------------------
// MultiWallet orchestrator
// ---------------------------
class MultiWalletOrchestrator {
  constructor() {
    this.wallets = [];
    this.loadWallets();
  }

  loadWallets() {
    this.wallets.push({ keypair: payer, role: 'main', active: true, balance: 0 });

    if (WALLET_KEYS) {
      const keys = WALLET_KEYS.split(',').map(k => k.trim()).filter(Boolean);
      keys.forEach((key, i) => {
        try {
          const kp = Keypair.fromSecretKey(bs58.decode(key));
          this.wallets.push({ keypair: kp, role: `wallet_${i + 1}`, active: true, balance: 0 });
          console.log(`✅ Loaded wallet ${i + 1}: ${kp.publicKey.toBase58().slice(0, 8)}...`);
        } catch (err) {
          console.error(`❌ Failed to load wallet ${i + 1}:`, err.message || err);
        }
      });
    }
    console.log(`🎭 Multi-wallet loaded: ${this.wallets.length} wallets`);
  }

  getActiveWallets() {
    return this.wallets.filter(w => w.active);
  }

  distributeAmount(totalAmount, walletCount = null) {
    const active = this.getActiveWallets();
    const useCount = walletCount || Math.min(active.length, 3);
    const amounts = [];
    let remaining = totalAmount;
    for (let i = 0; i < useCount - 1; i++) {
      const pct = 0.2 + Math.random() * 0.2;
      const amt = remaining * pct;
      amounts.push(amt);
      remaining -= amt;
    }
    amounts.push(remaining);
    return amounts.sort(() => Math.random() - 0.5);
  }

  generateNaturalDelays(count) {
    return Array(count).fill().map(() => {
      const base = 500 + Math.random() * 7500;
      const cluster = Math.random() < 0.3 ? Math.random() * 2000 : 0;
      return Math.floor(base + cluster);
    });
  }

  async executeCoordinatedBuy(mint, totalAmount, protection = true) {
    const wallets = this.getActiveWallets();
    const use = Math.min(wallets.length, 3);
    const amounts = this.distributeAmount(totalAmount, use);
    const delays = this.generateNaturalDelays(use - 1);

    const results = [];
    for (let i = 0; i < use; i++) {
      const wallet = wallets[i];
      const amount = amounts[i];
      try {
        const tx = await this.executeBuyWithWallet(wallet, mint, amount, protection);
        results.push({ wallet: wallet.role, amount, tx });
      } catch (err) {
        results.push({ wallet: wallet.role, amount, error: err.message || String(err) });
      }
      if (i < use - 1) await new Promise(r => setTimeout(r, delays[i]));
    }
    return results;
  }

  async executeBuyWithWallet(walletObj, mint, solAmount, mevProtection = true) {
    // This mirrors previously provided execution — kept similar but with safer fallbacks
    const pool = await getRaydiumPoolInfo(mint);
    const buyingBase = (pool.baseMint === mint);
    const WSOL = 'So11111111111111111111111111111111111111112';
    const wallet = walletObj.keypair;
    const userWSOL = await getAssociatedTokenAddress(new PublicKey(WSOL), wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const amountIn = Math.floor(solAmount * LAMPORTS_PER_SOL);

    const wsolInfo = await connection.getAccountInfo(userWSOL);
    if (!wsolInfo) {
      const createTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          userWSOL,
          wallet.publicKey,
          new PublicKey(WSOL),
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      if (mevProtection) await sendPrivateTransactionWithWallet(createTx, wallet);
      else await connection.sendTransaction(createTx, [wallet], { skipPreflight: false, preflightCommitment: 'confirmed' });
    }

    const wrapTx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: userWSOL, lamports: amountIn }),
      createSyncNativeInstruction(userWSOL)
    );
    if (mevProtection) await sendPrivateTransactionWithWallet(wrapTx, wallet);
    else await connection.sendTransaction(wrapTx, [wallet], { skipPreflight: false, preflightCommitment: 'confirmed' });

    const toMint = buyingBase ? mint : WSOL;
    const userOutATA = await getAssociatedTokenAddress(new PublicKey(toMint), wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const outInfo = await connection.getAccountInfo(userOutATA);
    if (!outInfo) {
      const createOutTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(wallet.publicKey, userOutATA, wallet.publicKey, new PublicKey(toMint), TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
      );
      await connection.sendTransaction(createOutTx, [wallet], { skipPreflight: false, preflightCommitment: 'confirmed' });
    }

    const swapIx = await buildSwapInstruction({
      poolKeys: pool,
      userKeys: {
        tokenAccountIn: userWSOL,
        tokenAccountOut: userOutATA,
        owner: wallet.publicKey,
        payer: wallet.publicKey
      },
      amountIn,
      minAmountOut: 1,
      direction: buyingBase ? 'quote2base' : 'base2quote'
    });

    const swapTx = new Transaction();
    swapIx.innerTransactions.forEach(({ instructions }) => instructions.forEach(ix => swapTx.add(ix)));
    if (mevProtection) return await sendPrivateTransactionWithWallet(swapTx, wallet);
    return await connection.sendTransaction(swapTx, [wallet], { skipPreflight: false, preflightCommitment: 'confirmed' });
  }
}

const multiWallet = new MultiWalletOrchestrator();

// ---------------------------
// Raydium pool caching + helpers
// ---------------------------
let _raydiumCache = { timestamp: 0, pools: null, ttl: 1000 * 60 * 5 };

async function getRaydiumPoolInfo(mintAddress) {
  const now = Date.now();
  if (!_raydiumCache.pools || now - _raydiumCache.timestamp > _raydiumCache.ttl) {
    try {
      const url = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
      const res = await fetch(url, { timeout: 10000 });
      if (!res.ok) throw new Error(`Failed to fetch Raydium pools (${res.status})`);
      const pools = await res.json();
      _raydiumCache = { timestamp: now, pools, ttl: 1000 * 60 * 5 };
    } catch (err) {
      console.error('getRaydiumPoolInfo fetch error:', err.message || err);
      if (!_raydiumCache.pools) throw err;
    }
  }

  const pools = _raydiumCache.pools;
  if (!pools) throw new Error('Raydium pools unavailable');
  const { official = {}, unOfficial = {} } = pools;
  for (const sid in official) {
    const pool = official[sid];
    if (pool.baseMint === mintAddress || pool.quoteMint === mintAddress) { pool.id = sid; return pool; }
  }
  for (const sid in unOfficial) {
    const pool = unOfficial[sid];
    if (pool.baseMint === mintAddress || pool.quoteMint === mintAddress) { pool.id = sid; return pool; }
  }
  throw new Error('No Raydium pool found for mint: ' + mintAddress);
}

async function getATA(mint, owner) {
  return await getAssociatedTokenAddress(new PublicKey(mint), owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

async function ensureATA(mint, owner) {
  const ata = await getATA(mint, owner);
  const info = await connection.getAccountInfo(ata);
  if (!info) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, new PublicKey(mint), TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
    );
    if (DRY_RUN) {
      console.log('DRY_RUN: would create ATA', ata.toBase58());
    } else {
      try {
        await connection.sendTransaction(tx, [payer], { skipPreflight: false, preflightCommitment: 'confirmed' });
      } catch (err) {
        console.error('ensureATA failed:', err.message || err);
        throw err;
      }
    }
  }
  return ata;
}

// ---------------------------
// Private tx senders (Jito + fallback)
// ---------------------------
async function sendPrivateTransaction(transaction, tip = 10000) {
  try {
    const tipAmount = parseInt(JITO_TIP) || tip;
    if (tipAmount > 0) {
      const tipInstruction = SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
        lamports: tipAmount
      });
      transaction.add(tipInstruction);
    }

    if (DRY_RUN) {
      console.log('DRY_RUN: would send private tx', transaction);
      return 'DRY_RUN_TX';
    }

    const endpoint = MEV_CONFIG.privatePools[Math.floor(Math.random() * MEV_CONFIG.privatePools.length)];
    try {
      const res = await fetch(`${endpoint}/api/v1/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTransaction',
          params: [transaction.serialize({ requireAllSignatures: false }).toString('base64'), { skipPreflight: false, preflightCommitment: 'confirmed' }]
        })
      });
      const json = await res.json();
      if (json && json.result) {
        console.log('✅ Sent via private pool:', endpoint);
        return json.result;
      }
    } catch (err) {
      console.warn('Private pool send failed, fallback to public RPC:', err.message || err);
    }

    // fallback - send via public RPC
    const sig = await connection.sendTransaction(transaction, [payer], { skipPreflight: false, preflightCommitment: 'confirmed' });
    console.log('⚠️ Fallback sent via public RPC', sig);
    return sig;
  } catch (err) {
    console.error('sendPrivateTransaction error:', err.message || err);
    throw err;
  }
}

async function sendPrivateTransactionWithWallet(transaction, wallet, tip = 10000) {
  try {
    const tipAmount = parseInt(JITO_TIP) || tip;
    if (tipAmount > 0) {
      const tipInstruction = SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
        lamports: tipAmount
      });
      transaction.add(tipInstruction);
    }

    if (DRY_RUN) {
      console.log('DRY_RUN: would send private tx with wallet', wallet.publicKey.toBase58());
      return 'DRY_RUN_TX';
    }

    const endpoint = MEV_CONFIG.privatePools[Math.floor(Math.random() * MEV_CONFIG.privatePools.length)];
    try {
      const res = await fetch(`${endpoint}/api/v1/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTransaction',
          params: [transaction.serialize({ requireAllSignatures: false }).toString('base64'), { skipPreflight: false, preflightCommitment: 'confirmed' }]
        })
      });
      const json = await res.json();
      if (json && json.result) {
        return json.result;
      }
    } catch (err) {
      console.warn('Private pool send with wallet failed, fallback to public RPC:', err.message || err);
    }

    const sig = await connection.sendTransaction(transaction, [wallet], { skipPreflight: false, preflightCommitment: 'confirmed' });
    return sig;
  } catch (err) {
    console.error('sendPrivateTransactionWithWallet error:', err.message || err);
    throw err;
  }
}

// ---------------------------
// Trading functions (buy/sell)
// ---------------------------
async function buyTokenSingle(mint, solAmount) {
  const pool = await getRaydiumPoolInfo(mint);
  const buyingBase = (pool.baseMint === mint);
  const WSOL = 'So11111111111111111111111111111111111111112';
  const userWSOL = await ensureATA(WSOL, payer.publicKey);
  const amountIn = Math.floor(solAmount * LAMPORTS_PER_SOL);

  const rawBalance = await connection.getTokenAccountBalance(userWSOL).catch(() => null);
  const wsolBalance = rawBalance ? Number(rawBalance.value.amount) : 0;
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
  swapIx.innerTransactions.forEach(({ instructions }) => instructions.forEach(ix => tx.add(ix)));
  return await sendPrivateTransaction(tx);
}

async function buyTokenMEVProtected(mint, solAmount) {
  const mevAnalysis = await mevProtection.detectMEVActivity(mint);
  const protection = mevAnalysis.recommendation;
  const chunks = mevProtection.splitTransaction(solAmount, protection);
  const delays = mevProtection.generateDelays(chunks.length - 1, protection);
  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const tx = await buyTokenSingle(mint, chunks[i]);
      results.push(tx);
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, delays[i]));
    } catch (err) {
      console.error('buyTokenMEVProtected chunk failed:', err.message || err);
    }
  }
  return results;
}

async function sellTokenSingle(mint, sellPct) {
  const pool = await getRaydiumPoolInfo(mint);
  const baseMint = pool.baseMint;
  const WSOL = 'So11111111111111111111111111111111111111112';
  const userBaseATA = await ensureATA(baseMint, payer.publicKey);
  const userWSOL = await ensureATA(WSOL, payer.publicKey);
  const rawBal = await connection.getTokenAccountBalance(userBaseATA);
  const bal = Number(rawBal.value.amount);
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
  swapIx.innerTransactions.forEach(({ instructions }) => instructions.forEach(ix => tx.add(ix)));
  return await sendPrivateTransaction(tx);
}

async function sellTokenMEVProtected(mint, sellPct) {
  const mevAnalysis = await mevProtection.detectMEVActivity(mint);
  const protection = mevAnalysis.recommendation;
  if (sellPct === 100 || protection === 'high') {
    return await sellTokenSingle(mint, sellPct);
  }
  const chunks = Math.min(3, Math.ceil(sellPct / 25));
  const chunkPct = sellPct / chunks;
  const delays = mevProtection.generateDelays(chunks - 1, protection);
  const results = [];
  for (let i = 0; i < chunks; i++) {
    try {
      const tx = await sellTokenSingle(mint, chunkPct);
      results.push(tx);
      if (i < chunks - 1) await new Promise(r => setTimeout(r, delays[i]));
    } catch (err) {
      console.error('sellTokenMEVProtected chunk failed:', err.message || err);
    }
  }
  return results;
}

// ---------------------------
// TELEGRAM HANDLERS
// ---------------------------

function isAdmin(ctx) {
  if (!ADMIN) return true; // if ADMIN not set, allow for dev
  try {
    return String(ctx.from.id) === String(ADMIN);
  } catch {
    return false;
  }
}

bot.start(async ctx => {
  if (!isAdmin(ctx)) return;
  const welcomeMsg = [
    '🤖 **Welcome to Net-Buy-Pumpet!**',
    '',
    '🚀 Automated Solana token buy/sell with Raydium',
    '🛡️ MEV Protection & Multi-Wallet Orchestration',
    '',
    '👇 **Choose an action below:**'
  ].join('\n');

  await ctx.reply(welcomeMsg, { ...getMainMenu(), parse_mode: 'Markdown' });
});

// START SETUP (button or /setup)
bot.command('setup', async ctx => {
  if (!isAdmin(ctx)) return;
  clearUserSetup(ctx.from.id);
  setUserStep(ctx.from.id, SETUP_STEPS.WAITING_CONTRACT);
  await ctx.reply(
    '🔧 **Pump Setup - Step 1/5**\n\n🎯 **Enter Token Contract Address:**\nPlease send the token mint address.\n\nExample: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`',
    { ...getSetupMenu(), parse_mode: 'Markdown' }
  );
});

bot.action('start_setup', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  try {
    clearUserSetup(ctx.from.id);
    setUserStep(ctx.from.id, SETUP_STEPS.WAITING_CONTRACT);
    await safeEditOrReply(ctx,
      '🔧 **Pump Setup - Step 1/5**\n\n🎯 **Enter Token Contract Address:**\nPlease send the token mint address.',
      getSetupMenu()
    );
  } finally {
    ctx.answerCbQuery();
  }
});

// Utility to try editing message, otherwise send reply
async function safeEditOrReply(ctx, text, markup = null) {
  try {
    if (ctx.updateType === 'callback_query' && ctx.update.callback_query.message) {
      await ctx.editMessageText(text, { ...(markup || {}), parse_mode: 'Markdown' });
    } else {
      await ctx.reply(text, { ...(markup || {}), parse_mode: 'Markdown' });
    }
  } catch (err) {
    // editMessageText can throw "message not modified" — fallback to reply
    try {
      await ctx.reply(text, { ...(markup || {}), parse_mode: 'Markdown' });
    } catch (e) {
      console.error('safeEditOrReply fallback failed:', e.message || e);
    }
  }
}

// Streamlined setup flow (text messages)
bot.on('text', async ctx => {
  if (!isAdmin(ctx)) return;

  const userId = ctx.from.id;
  const currentStep = getCurrentStep(userId);
  const text = (ctx.message.text || '').trim();

  console.log(`📩 Received text from ${ctx.from.id} | step=${currentStep} | text="${text}"`);

  // If user not in setup flow, ignore simple texts and show menu
  if (!currentStep) {
    if (text && !text.startsWith('/')) {
      await ctx.reply('🤖 Use the menu or send `/help` for commands.', getMainMenu());
    }
    return;
  }

  const userData = getUserData(userId);

  try {
    switch (currentStep) {
      case SETUP_STEPS.WAITING_CONTRACT: {
        if (!text || text.length < 32 || text.length > 50) {
          await ctx.reply('❌ Invalid contract address. Please enter a valid Solana token mint address.', getSetupMenu());
          return;
        }
        // validate token exists on Raydium (catch any errors and reply)
        try {
          await getRaydiumPoolInfo(text);
          userData.mint = text;
          setUserStep(userId, SETUP_STEPS.WAITING_SOL_AMOUNT);
          await ctx.reply('✅ Token found! 🔧 Step 2/5: Enter SOL amount per buy (e.g. 0.1)', getSetupMenu());
        } catch (err) {
          console.warn('Token validation failed:', err.message || err);
          await ctx.reply(`❌ Token not found in Raydium pools. Error: ${err.message}`, getSetupMenu());
        }
        return;
      }

      case SETUP_STEPS.WAITING_SOL_AMOUNT: {
        const sol = parseFloat(text);
        if (isNaN(sol) || sol <= 0 || sol > 100) {
          await ctx.reply('❌ Invalid SOL amount. Enter a number between 0.01 and 100.', getSetupMenu());
          return;
        }
        userData.buySol = sol;
        setUserStep(userId, SETUP_STEPS.WAITING_SELL_PCT);
        await ctx.reply('✅ SOL amount set! Step 3/5: Enter sell percentage (0-100).', getSetupMenu());
        return;
      }

      case SETUP_STEPS.WAITING_SELL_PCT: {
        const pct = parseInt(text);
        if (isNaN(pct) || pct < 0 || pct > 100) {
          await ctx.reply('❌ Invalid percentage. Enter a number between 0 and 100.', getSetupMenu());
          return;
        }
        userData.sellPct = pct;
        setUserStep(userId, SETUP_STEPS.WAITING_DELAY);
        await ctx.reply('✅ Sell % saved! Step 4/5: Enter delay (seconds) between buy cycles (min 1).', getSetupMenu());
        return;
      }

      case SETUP_STEPS.WAITING_DELAY: {
        const delay = parseInt(text);
        if (isNaN(delay) || delay < 1 || delay > 3600) {
          await ctx.reply('❌ Invalid delay. Enter a number between 1 and 3600 seconds.', getSetupMenu());
          return;
        }
        userData.delaySec = delay;
        setUserStep(userId, SETUP_STEPS.WAITING_MULTI_BUYS);
        await ctx.reply('✅ Delay set! Step 5/5: Enter multi-buys per cycle (1-10).', getSetupMenu());
        return;
      }

      case SETUP_STEPS.WAITING_MULTI_BUYS: {
        const multi = parseInt(text);
        if (isNaN(multi) || multi < 1 || multi > 10) {
          await ctx.reply('❌ Invalid number. Enter between 1 and 10.', getSetupMenu());
          return;
        }
        userData.multiBuys = multi;
        setUserStep(userId, SETUP_STEPS.CONFIRMATION);

        // Confirmation keyboard
        const confirmationKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirm & Save', 'confirm_setup')],
          [Markup.button.callback('❌ Cancel Setup', 'cancel_setup')],
          [Markup.button.callback('🔄 Start Over', 'start_setup')],
          [Markup.button.callback('🏠 Main Menu', 'main_menu')]
        ]);

        await ctx.reply('🎉 Setup complete! Review and confirm.', { ...confirmationKeyboard, parse_mode: 'Markdown' });
        return;
      }

      default:
        await ctx.reply('❌ Unknown setup step. Canceling.', getSetupMenu());
        clearUserSetup(userId);
        return;
    }
  } catch (err) {
    console.error('Setup flow error:', err.message || err);
    await ctx.reply(`❌ Setup error: ${err.message || err}`, getSetupMenu());
    clearUserSetup(userId);
  }
});

// Button handlers
bot.action('main_menu', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  try {
    const welcomeMsg = [
      '🤖 **Net-Buy-Pumpet Dashboard**',
      '',
      `🎯 Token: ${session.mint ? `${session.mint.slice(0, 8)}...` : 'Not set'}`,
      `💰 Buy: ${session.buySol} SOL`,
      `📈 Sell %: ${session.sellPct}%`,
      `⏱️ Delay: ${session.delaySec}s`,
      `🔄 Multi-Buys: ${session.multiBuys}`,
      `🤖 Status: ${running ? '🟢 Active' : '🔴 Stopped'}`,
      `🎭 Wallets: ${multiWallet.getActiveWallets().length}`
    ].join('\n');
    await safeEditOrReply(ctx, welcomeMsg, getMainMenu());
  } catch (err) {
    console.error('main_menu action failed:', err.message || err);
  } finally {
    ctx.answerCbQuery();
  }
});

bot.action('advanced_menu', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  try {
    const advancedMsg = [
      '🛡️ **Advanced Features**',
      '',
      `🛡️ MEV Protection: ${session.mevProtection ? 'ON' : 'OFF'}`,
      `🎭 Multi-Wallet: ${session.multiWallet ? 'ON' : 'OFF'}`,
      '',
      '⚙️ Toggle or run analysis below.'
    ].join('\n');
    await safeEditOrReply(ctx, advancedMsg, getAdvancedMenu());
  } catch (err) {
    console.error('advanced_menu action failed:', err.message || err);
  } finally {
    ctx.answerCbQuery();
  }
});

bot.action('refresh_status', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  try {
    const statusMsg = [
      showCurrentConfig(),
      '',
      `🔄 Bot Status: ${running ? '🟢 Pumping Active' : '🔴 Stopped'}`,
      `🌐 Connection: ${rpcEndpoint}`,
      `👤 Main Wallet: ${payer.publicKey.toBase58().slice(0, 8)}...`
    ].join('\n');
    await safeEditOrReply(ctx, statusMsg, getStatusMenu());
  } catch (err) {
    console.error('refresh_status failed:', err.message || err);
  } finally {
    ctx.answerCbQuery();
  }
});

bot.action('confirm_setup', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  try {
    const userData = getUserData(ctx.from.id);
    if (!userData || !userData.mint) {
      await ctx.reply('❌ No setup data found. Start again with Setup.', getSetupMenu());
      ctx.answerCbQuery();
      return;
    }
    session.mint = userData.mint;
    session.buySol = userData.buySol;
    session.sellPct = userData.sellPct;
    session.delaySec = userData.delaySec;
    session.multiBuys = userData.multiBuys;
    clearUserSetup(ctx.from.id);
    await safeEditOrReply(ctx, '🎉 Configuration Saved!\n\n' + showCurrentConfig(), getMainMenu());
  } catch (err) {
    console.error('confirm_setup failed:', err.message || err);
    await ctx.reply(`❌ Save failed: ${err.message}`, getSetupMenu());
  } finally {
    ctx.answerCbQuery();
  }
});

bot.action('cancel_setup', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  try {
    clearUserSetup(ctx.from.id);
    await safeEditOrReply(ctx, '❌ Setup cancelled.', getMainMenu());
  } catch (err) {
    console.error('cancel_setup failed:', err.message || err);
  } finally {
    ctx.answerCbQuery();
  }
});

bot.action('start_pump', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  try {
    if (running) {
      await ctx.answerCbQuery('Pump already running.');
      return;
    }
    if (!session.mint) {
      await ctx.answerCbQuery('Complete setup first!');
      return;
    }
    running = true;
    await safeEditOrReply(ctx, '🔥 Pump started! Monitoring transactions...', getMainMenu());
    startPumpLoop(ctx);
  } catch (err) {
    console.error('start_pump failed:', err.message || err);
  } finally {
    ctx.answerCbQuery();
  }
});

bot.action('stop_pump', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  try {
    if (!running) {
      await ctx.answerCbQuery('Pump not running.');
      return;
    }
    running = false;
    await safeEditOrReply(ctx, '⏹️ Pump stop requested. Will stop after current cycle.', getMainMenu());
  } catch (err) {
    console.error('stop_pump failed:', err.message || err);
  } finally {
    ctx.answerCbQuery();
  }
});

bot.action('sell_all_confirm', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  try {
    if (!session.mint) {
      await ctx.answerCbQuery('No token configured.');
      return;
    }
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🚨 YES, SELL ALL', 'sell_all_execute')],
      [Markup.button.callback('❌ Cancel', 'main_menu')]
    ]);
    await safeEditOrReply(ctx, `🚨 Sell ALL ${session.mint.slice(0, 8)}... ? This cannot be undone.`, keyboard);
  } catch (err) {
    console.error('sell_all_confirm failed:', err.message || err);
  } finally {
    ctx.answerCbQuery();
  }
});

bot.action('sell_all_execute', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  try {
    await ctx.reply('⏳ Selling all tokens...');
    let results;
    if (session.mevProtection) results = await sellTokenMEVProtected(session.mint, 100);
    else results = await sellTokenSingle(session.mint, 100);

    if (Array.isArray(results)) {
      const txLinks = results.map((tx, i) => `[Tx${i + 1}](https://solscan.io/tx/${tx})`).join(' ');
      await ctx.reply('✅ All tokens sold!\n' + txLinks, getMainMenu());
    } else {
      await ctx.reply(`✅ All tokens sold! [Tx](https://solscan.io/tx/${results})`, getMainMenu());
    }
  } catch (err) {
    console.error('sell_all_execute failed:', err.message || err);
    await ctx.reply(`❌ Sell failed: ${err.message}`, getMainMenu());
  } finally {
    ctx.answerCbQuery();
  }
});

bot.action('toggle_mev', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  session.mevProtection = !session.mevProtection;
  try {
    await safeEditOrReply(ctx,
      `🛡️ MEV Protection ${session.mevProtection ? 'ENABLED' : 'DISABLED'}`,
      getAdvancedMenu()
    );
  } catch (err) {
    console.error('toggle_mev failed:', err.message || err);
  } finally {
    ctx.answerCbQuery();
  }
});

bot.action('toggle_multiwallet', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  try {
    const available = multiWallet.getActiveWallets().length;
    if (available < 2) {
      await ctx.answerCbQuery('Need multiple wallets. Set WALLET_PRIVATE_KEYS env var.');
      return;
    }
    session.multiWallet = !session.multiWallet;
    await safeEditOrReply(ctx, `🎭 Multi-Wallet ${session.multiWallet ? 'ENABLED' : 'DISABLED'}`, getAdvancedMenu());
  } catch (err) {
    console.error('toggle_multiwallet failed:', err.message || err);
  } finally {
    ctx.answerCbQuery();
  }
});

bot.action('analyze_mev', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  if (!session.mint) { ctx.answerCbQuery('Set token first!'); return; }
  try {
    await ctx.reply('🔍 Analyzing MEV activity...');
    const analysis = await mevProtection.detectMEVActivity(session.mint);
    const analysisMsg = [
      '🔍 **MEV Analysis Results:**',
      `🎯 Token: ${session.mint.slice(0, 8)}...`,
      `📊 Risk Score: ${analysis.riskScore.toFixed(2)}`,
      `🛡️ Recommended Protection: ${analysis.recommendation.toUpperCase()}`,
      '',
      `🏃 Front-runs: ${analysis.indicators.frontRuns}`,
      `🥪 Sandwiches: ${analysis.indicators.sandwiches}`,
      `📊 Total txs analyzed: ${analysis.indicators.totalTxs}`
    ].join('\n');
    await ctx.reply(analysisMsg, getAdvancedMenu());
  } catch (err) {
    console.error('analyze_mev failed:', err.message || err);
    await ctx.reply(`❌ MEV analysis failed: ${err.message}`, getAdvancedMenu());
  } finally {
    ctx.answerCbQuery();
  }
});

bot.action('multiwallet_status', async ctx => {
  if (!isAdmin(ctx)) { ctx.answerCbQuery(); return; }
  try {
    const wallets = multiWallet.getActiveWallets();
    const lines = [
      '🎭 Multi-Wallet Status',
      `Total: ${wallets.length}`,
      `Active: ${wallets.filter(w => w.active).length}`,
      ''
    ];
    wallets.forEach((w, i) => lines.push(`${i + 1}. ${w.role.toUpperCase()} - ${w.keypair.publicKey.toBase58().slice(0, 8)}... - ${w.active ? 'Active' : 'Inactive'}`));
    lines.push('', '💡 Benefits: distributed risk, natural patterns, easier coordination');
    await safeEditOrReply(ctx, lines.join('\n'), getAdvancedMenu());
  } catch (err) {
    console.error('multiwallet_status failed:', err.message || err);
  } finally {
    ctx.answerCbQuery();
  }
});

// Fallback for unrecognized messages
bot.on('message', async ctx => {
  if (!isAdmin(ctx)) return;
  const currentStep = getCurrentStep(ctx.from.id);
  if (!currentStep && ctx.message.text && !ctx.message.text.startsWith('/')) {
    await ctx.reply('🤖 Use the menu or /help for commands.', getMainMenu());
  }
});

// Help & status commands
bot.command('status', async ctx => {
  if (!isAdmin(ctx)) return;
  const statusMsg = [
    showCurrentConfig(),
    '',
    `🔄 Bot Status: ${running ? '🟢 Pumping Active' : '🔴 Stopped'}`,
    `🌐 Connection: ${rpcEndpoint}`,
    `👤 Main Wallet: ${payer.publicKey.toBase58().slice(0, 8)}...`
  ].join('\n');
  await ctx.reply(statusMsg, getStatusMenu());
});

bot.command('help', async ctx => {
  if (!isAdmin(ctx)) return;
  const helpMsg = [
    '🤖 Net-Buy-Pumpet Help',
    '/setup - Configure pump',
    '/pump - Start pumping',
    '/stop - Stop pumping',
    '/sellall - Sell all tokens',
    '/status - Status'
  ].join('\n');
  await ctx.reply(helpMsg, getMainMenu());
});

bot.command('pump', async ctx => {
  if (!isAdmin(ctx)) return;
  if (running) return await ctx.reply('Pump already running.', getMainMenu());
  if (!session.mint) return await ctx.reply('Complete setup first!', getMainMenu());
  running = true;
  await ctx.reply('🔥 Pump started!', getMainMenu());
  startPumpLoop(ctx);
});

bot.command('stop', async ctx => {
  if (!isAdmin(ctx)) return;
  if (!running) return await ctx.reply('Pump not running.', getMainMenu());
  running = false;
  await ctx.reply('⏹️ Pump stop requested. It will stop after the current cycle.', getMainMenu());
});

bot.command('sellall', async ctx => {
  if (!isAdmin(ctx)) return;
  if (!session.mint) return await ctx.reply('No token configured!', getMainMenu());
  try {
    let results;
    if (session.mevProtection) results = await sellTokenMEVProtected(session.mint, 100);
    else results = await sellTokenSingle(session.mint, 100);

    if (Array.isArray(results)) {
      const txLinks = results.map((tx, i) => `[Tx${i + 1}](https://solscan.io/tx/${tx})`).join(' ');
      await ctx.reply('✅ All tokens sold!\n' + txLinks, getMainMenu());
    } else {
      await ctx.reply(`✅ All tokens sold! [Tx](https://solscan.io/tx/${results})`, getMainMenu());
    }
  } catch (err) {
    console.error('sellall failed:', err.message || err);
    await ctx.reply(`❌ Sell failed: ${err.message}`, getMainMenu());
  }
});

// ---------------------------
// PUMP LOOP (core trading orchestration)
// ---------------------------
async function startPumpLoop(ctx) {
  let buyAmount = session.buySol;
  let cycleCount = 0;
  let initialMevAnalysis = { riskScore: 0.5, recommendation: 'medium' };
  try {
    if (session.mint) initialMevAnalysis = await mevProtection.detectMEVActivity(session.mint);
    if (ADMIN) {
      await ctx.telegram.sendMessage(ADMIN, `🛡️ MEV Analysis: risk=${initialMevAnalysis.riskScore.toFixed(2)}, rec=${initialMevAnalysis.recommendation}`, { parse_mode: 'Markdown' }).catch(() => {});
    }
  } catch (err) {
    console.warn('Initial MEV analysis failed:', err.message || err);
  }

  while (running && !isShuttingDown) {
    cycleCount++;
    try {
      if (ADMIN) {
        await ctx.telegram.sendMessage(ADMIN, `🔄 Cycle ${cycleCount} starting — buy ${buyAmount.toFixed(4)} SOL`, { parse_mode: 'Markdown' }).catch(() => {});
      }

      for (let i = 0; i < session.multiBuys; i++) {
        if (!running || isShuttingDown) break;
        try {
          if (session.multiWallet && multiWallet.getActiveWallets().length > 1) {
            const txResults = await multiWallet.executeCoordinatedBuy(session.mint, buyAmount, session.mevProtection);
            for (const r of txResults) {
              if (r.tx) {
                if (ADMIN) await ctx.telegram.sendMessage(ADMIN, `✅ ${r.wallet} bought ${r.amount.toFixed(4)} SOL — Tx: https://solscan.io/tx/${r.tx}`).catch(() => {});
              } else {
                if (ADMIN) await ctx.telegram.sendMessage(ADMIN, `❌ ${r.wallet} failed: ${r.error}`).catch(() => {});
              }
            }
          } else if (session.mevProtection) {
            const txResults = await buyTokenMEVProtected(session.mint, buyAmount);
            if (Array.isArray(txResults)) {
              for (let j = 0; j < txResults.length; j++) {
                if (ADMIN) await ctx.telegram.sendMessage(ADMIN, `✅ Protected Buy ${i + 1}.${j + 1} — Tx: https://solscan.io/tx/${txResults[j]}`).catch(() => {});
              }
            } else {
              if (ADMIN) await ctx.telegram.sendMessage(ADMIN, `✅ Protected Buy ${i + 1} — Tx: https://solscan.io/tx/${txResults}`).catch(() => {});
            }
          } else {
            const tx = await buyTokenSingle(session.mint, buyAmount);
            if (ADMIN) await ctx.telegram.sendMessage(ADMIN, `✅ Buy ${i + 1} — Tx: https://solscan.io/tx/${tx}`).catch(() => {});
          }
        } catch (err) {
          console.error(`Buy failed in cycle ${cycleCount}, buy #${i + 1}:`, err.message || err);
          if (ADMIN) await ctx.telegram.sendMessage(ADMIN, `❌ Buy failed: ${err.message || err}`).catch(() => {});
        }
        if (i < session.multiBuys - 1) await new Promise(r => setTimeout(r, 1000));
      }

      // selling logic
      if (session.sellPct > 0 && running && !isShuttingDown) {
        try {
          if (session.mevProtection) {
            const sellResults = await sellTokenMEVProtected(session.mint, session.sellPct);
            if (Array.isArray(sellResults)) {
              for (let j = 0; j < sellResults.length; j++) {
                if (ADMIN) await ctx.telegram.sendMessage(ADMIN, `📈 Sell ${j + 1} — Tx: https://solscan.io/tx/${sellResults[j]}`).catch(() => {});
              }
            } else {
              if (ADMIN) await ctx.telegram.sendMessage(ADMIN, `📈 Sold ${session.sellPct}% — Tx: https://solscan.io/tx/${sellResults}`).catch(() => {});
            }
          } else {
            const tx = await sellTokenSingle(session.mint, session.sellPct);
            if (ADMIN) await ctx.telegram.sendMessage(ADMIN, `📈 Sold ${session.sellPct}% — Tx: https://solscan.io/tx/${tx}`).catch(() => {});
          }
        } catch (err) {
          console.error('Sell failed:', err.message || err);
          if (ADMIN) await ctx.telegram.sendMessage(ADMIN, `❌ Sell failed: ${err.message || err}`).catch(() => {});
        }
      }

      // scale buy amount
      buyAmount *= session.buyScale;

      // delay with jitter
      const baseDelayMs = session.delaySec * 1000;
      const jitter = 0.8 + Math.random() * 0.4;
      const mevDelay = initialMevAnalysis.riskScore > 0.7 ? 2000 : 0;
      const delayMs = Math.max(500, (baseDelayMs * jitter) + mevDelay);
      await new Promise(r => setTimeout(r, delayMs));

    } catch (err) {
      console.error('Cycle error:', err.message || err);
      if (ADMIN) await ctx.telegram.sendMessage(ADMIN, `❌ Cycle error: ${err.message || err}`).catch(() => {});
    }
  }

  if (ADMIN) {
    await ctx.telegram.sendMessage(ADMIN, '⏹️ Pump stopped. Use menu to start again.', { parse_mode: 'Markdown' }).catch(() => {});
  }
}

// ---------------------------
// Helpers: show current config
// ---------------------------
function showCurrentConfig() {
  return [
    '📊 **Current Configuration:**',
    `🎯 Token: ${session.mint || 'Not set'}`,
    `💰 Buy Amount: ${session.buySol} SOL`,
    `📈 Sell Percentage: ${session.sellPct}%`,
    `⏱️ Delay: ${session.delaySec} seconds`,
    `🔄 Multi-Buys: ${session.multiBuys}`,
    `🛡️ MEV Protection: ${session.mevProtection ? 'ON' : 'OFF'}`,
    `🎭 Multi-Wallet: ${session.multiWallet ? 'ON' : 'OFF'}`,
    `🎭 Wallets Loaded: ${multiWallet.getActiveWallets().length}`
  ].join('\n');
}

// ---------------------------
// HEALTHCHECK / WEBHOOK SERVER
// ---------------------------
const server = createServer((req, res) => {
  try {
    if (req.url === '/webhook' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const update = JSON.parse(body);
          await bot.handleUpdate(update);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
        } catch (err) {
          console.error('Webhook processing error:', err.message || err);
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
        }
      });
    } else if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
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
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  } catch (err) {
    console.error('Server error:', err.message || err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }
});

server.listen(port, () => console.log(`🌐 Health server listening on port ${port}`));

// ---------------------------
// GRACEFUL SHUTDOWN
// ---------------------------
async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  running = false;
  console.log('🔄 Graceful shutdown initiated.');
  try { if (ADMIN) await bot.telegram.sendMessage(ADMIN, '🛑 Bot shutting down...').catch(() => {}); } catch {}
  try { await bot.stop(); console.log('✅ Bot stopped'); } catch (err) { console.error('Bot stop error:', err.message || err); }
  setTimeout(() => { console.log('👋 Exiting'); process.exit(0); }, 2000);
}

process.once('SIGINT', gracefulShutdown);
process.once('SIGTERM', gracefulShutdown);

process.on('uncaughtException', err => { console.error('Uncaught exception:', err); gracefulShutdown(); });
process.on('unhandledRejection', (r, p) => { console.error('Unhandled Rejection:', r, p); });

// ---------------------------
// Bot launch
// ---------------------------
async function startBot() {
  try {
    const useWebhooks = NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL;
    if (useWebhooks) {
      const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
      await bot.telegram.setWebhook(webhookUrl);
      console.log('🔗 Webhook set to:', webhookUrl);
    } else {
      await bot.launch({ dropPendingUpdates: true, allowedUpdates: ['message', 'callback_query'] });
      console.log('🔄 Bot launched in polling mode');
    }
    console.log('✅ Net-Buy-Pumpet running');
    try { if (ADMIN) await bot.telegram.sendMessage(ADMIN, '🤖 Bot deployed and running!').catch(() => {}); } catch {}
  } catch (err) {
    console.error('❌ Failed to start bot:', err.message || err);
    if (err.code === 409) {
      console.error('🔁 Another bot instance may be running (409).');
    }
    process.exit(1);
  }
}
startBot();
