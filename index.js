// index.js
// package.json must include: { "type": "module" }

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

// ONLY import Raydium SDK here (avoid re-imports later)
const { buildSwapInstruction } = require('@raydium-io/raydium-sdk');

/* =========================
   Logger helpers (timestamps)
========================= */
const ts = () => new Date().toISOString();
const log   = (...args) => console.log(`[${ts()}]`, ...args);
const warn  = (...args) => console.warn(`[${ts()}] ⚠️`, ...args);
const error = (...args) => console.error(`[${ts()}] 💥`, ...args);

/* =========================
   MEV / Trading configuration
========================= */
const MEV_CONFIG = {
  privatePools: [
    'https://mainnet.block-engine.jito.wtf',
    'https://amsterdam.mainnet.block-engine.jito.wtf',
    'https://frankfurt.mainnet.block-engine.jito.wtf',
    'https://ny.mainnet.block-engine.jito.wtf',
    'https://tokyo.mainnet.block-engine.jito.wtf'
  ],
  // Intentional: at higher MEV risk we use tighter (smaller) max slippage
  maxSlippage: { low: 1.0, medium: 0.7, high: 0.3 },
  maxChunkSize: 0.5,   // max SOL per chunk (fraction of total buy)
  minChunks: 2,
  maxChunks: 5,
  minDelay: 100,       // ms
  maxDelay: 3000,      // ms
  mevRiskThreshold: 0.7
};

/* =========================
   ENV parsing & validation
========================= */
const {
  BOT_TOKEN,
  ADMIN,
  RPC_ENDPOINT,
  PAYER_PRIVATE_KEY,
  WALLET_PRIVATE_KEYS,     // comma-separated or JSON array; optional
  JITO_TIP,                // optional, integer lamports
  NODE_ENV,
  RENDER_EXTERNAL_URL,
  PORT
} = process.env;

// Basic required envs
const missing = [];
if (!BOT_TOKEN)         missing.push('BOT_TOKEN');
if (!ADMIN)             missing.push('ADMIN');
if (!RPC_ENDPOINT)      missing.push('RPC_ENDPOINT');
if (!PAYER_PRIVATE_KEY) missing.push('PAYER_PRIVATE_KEY');

if (missing.length) {
  const msg = `Missing required env var(s): ${missing.join(', ')}`;
  error(msg);
  throw new Error(msg);
}

const adminIdStr = String(ADMIN).trim();
if (!/^\d+$/.test(adminIdStr)) {
  const msg = `ADMIN must be a numeric Telegram user id. Got: "${ADMIN}"`;
  error(msg);
  throw new Error(msg);
}

// numeric optional envs
const jitoTipLamports = (() => {
  if (!JITO_TIP) return 0;
  const n = Number(JITO_TIP);
  if (!Number.isFinite(n) || n < 0) {
    warn(`JITO_TIP invalid ("${JITO_TIP}"), defaulting to 0`);
    return 0;
  }
  return Math.floor(n);
})();

// Port / mode
const port = Number(PORT) || 3000;
const useWebhooks = NODE_ENV === 'production' && !!RENDER_EXTERNAL_URL;

/* =========================
   Key parsing helpers
========================= */
function parseKeypair(input, label = 'PAYER_PRIVATE_KEY') {
  // Accept bs58 string or JSON array of numbers
  try {
    // Try bs58
    const secret = bs58.decode(input.trim());
    if (secret.length === 64) {
      const kp = Keypair.fromSecretKey(secret);
      return kp;
    }
    // If it decoded but length unexpected, fall through to JSON path
    warn(`${label} decoded via bs58 but secret length = ${secret.length} (expected 64). Trying JSON...`);
  } catch (_) {
    // ignore, try JSON route
  }

  try {
    const arr = JSON.parse(input);
    if (!Array.isArray(arr)) throw new Error('not an array');
    const uint8 = Uint8Array.from(arr);
    const kp = Keypair.fromSecretKey(uint8);
    return kp;
  } catch (e) {
    const msg = `${label} is neither valid bs58 nor JSON array.`;
    error(msg);
    throw new Error(msg);
  }
}

function parseMultiWallets(input) {
  const wallets = [];
  if (!input) return wallets;

  // allow JSON array of arrays OR comma-separated bs58 keys
  try {
    const maybeJson = JSON.parse(input);
    if (Array.isArray(maybeJson)) {
      for (const item of maybeJson) {
        try {
          const kp = Array.isArray(item)
            ? Keypair.fromSecretKey(Uint8Array.from(item))
            : parseKeypair(item, 'WALLET_PRIVATE_KEYS[]');
          wallets.push(kp);
        } catch (e) {
          warn('Skipping invalid wallet key in JSON list:', e.message);
        }
      }
      return wallets;
    }
  } catch (_) {
    // not JSON, treat as comma-separated list
  }

  const parts = input.split(',').map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    try {
      wallets.push(parseKeypair(p, 'WALLET_PRIVATE_KEYS item'));
    } catch (e) {
      warn('Skipping invalid wallet key in CSV list:', e.message);
    }
  }
  return wallets;
}

/* =========================
   Core singletons
========================= */
const rpcEndpoint = RPC_ENDPOINT.trim();
const connection = new Connection(rpcEndpoint, 'confirmed');

const payer = parseKeypair(PAYER_PRIVATE_KEY, 'PAYER_PRIVATE_KEY');

const extraWallets = parseMultiWallets(WALLET_PRIVATE_KEYS);
log(`🎭 Multi-wallet system loaded: ${extraWallets.length + 1} wallets`);

// Telegraf bot — single instance
const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 90_000 // ms
});

// Basic in-memory session/state (replace if you add Redis later)
const session = {
  mint: null,
  buySol: 0.1,
  sellPct: 0,
  delaySec: 5,
  multiBuys: 1,
  buyScale: 1.0,
  mevProtection: true,
  multiWallet: extraWallets.length > 0
};

let running = false;
let isShuttingDown = false;

// Simple setup wizard tracking
const SETUP_STEPS = {
  WAITING_CONTRACT: 'waiting_contract',
  WAITING_SOL_AMOUNT: 'waiting_sol_amount',
  WAITING_SELL_PCT: 'waiting_sell_pct',
  WAITING_DELAY: 'waiting_delay',
  WAITING_MULTI_BUYS: 'waiting_multi_buys',
  CONFIRMATION: 'confirmation'
};

const setupFlow = {
  users: new Map(), // userId -> step
  data:  new Map()  // userId -> partial config object
};

function getCurrentStep(userId) {
  return setupFlow.users.get(userId);
}
function setUserStep(userId, step) {
  setupFlow.users.set(userId, step);
}
function getUserData(userId) {
  if (!setupFlow.data.has(userId)) setupFlow.data.set(userId, {});
  return setupFlow.data.get(userId);
}
function clearUserSetup(userId) {
  setupFlow.users.delete(userId);
  setupFlow.data.delete(userId);
  }

// === BASIC CONFIGURATION ===
// === BASIC CONFIGURATION ===
const {
  TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
  ADMIN_CHAT_ID: ADMIN,
  SOLANA_PRIVATE_KEY: PRIVATE_KEY,
  SOLANA_RPC_URL: RPC_URL,
  JITO_TIP_AMOUNT: JITO_TIP,
  WALLET_PRIVATE_KEYS: WALLET_KEYS
} = process.env;

// Validate critical environment variables
if (!TELEGRAM_TOKEN) throw new Error("❌ TELEGRAM_BOT_TOKEN is missing in environment");
if (!ADMIN) throw new Error("❌ ADMIN_CHAT_ID is missing in environment");
if (!PRIVATE_KEY) throw new Error("❌ SOLANA_PRIVATE_KEY is missing in environment");

const rpcEndpoint = RPC_URL || 'https://api.mainnet-beta.solana.com';
console.log(`🌐 Using Solana RPC endpoint: ${rpcEndpoint}`);

let payer;
try {
  payer = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  console.log(`💼 Main wallet loaded: ${payer.publicKey.toString().slice(0, 8)}...`);
} catch (err) {
  console.error("❌ Failed to decode SOLANA_PRIVATE_KEY:", err.message);
  process.exit(1);
}

const connection = new Connection(rpcEndpoint, 'confirmed');
const bot = new Telegraf(TELEGRAM_TOKEN);

let running = false;
let isShuttingDown = false;

// Global session state
let session = {
  mint: '',
  buySol: 0,
  sellPct: 0,
  delaySec: 2,
  buyScale: 1.1,
  multiBuys: 3,
  mevProtection: true,
  multiWallet: false
};

// Setup flow state
const setupFlow = {
  users: new Map(),
  data: new Map()
};

const SETUP_STEPS = {
  WAITING_CONTRACT: 'waiting_contract',
  WAITING_SOL_AMOUNT: 'waiting_sol_amount',
  WAITING_SELL_PCT: 'waiting_sell_pct',
  WAITING_DELAY: 'waiting_delay',
  WAITING_MULTI_BUYS: 'waiting_multi_buys',
  CONFIRMATION: 'confirmation'
};

// === MEV PROTECTION CLASS ===
class MEVProtection {
  constructor() {
    this.mevHistory = [];
    this.attackPatterns = new Map();
  }

  async detectMEVActivity(mint) {
    console.log(`🔍 Starting MEV analysis for token: ${mint}`);
    try {
      const signatures = await connection.getConfirmedSignaturesForAddress2(
        new PublicKey(mint),
        { limit: 50 }
      );
      console.log(`📜 Retrieved ${signatures.length} signatures for analysis`);

      const txDetails = await Promise.all(
        signatures.slice(0, 20).map(sig =>
          connection.getTransaction(sig.signature, { commitment: 'confirmed' })
        )
      );

      const mevIndicators = {
        frontRuns: 0, // TODO: add detection heuristics
        sandwiches: 0,
        copyTrades: 0,
        totalTxs: txDetails.filter(Boolean).length
      };

      const riskScore = this.calculateMEVRisk(mevIndicators);

      console.log(`🔎 MEV analysis results for ${mint.slice(0, 8)}...`, {
        totalTxs: mevIndicators.totalTxs,
        riskScore: riskScore.toFixed(2),
        recommendation: this.getProtectionRecommendation(riskScore)
      });

      return {
        riskScore,
        indicators: mevIndicators,
        recommendation: this.getProtectionRecommendation(riskScore)
      };
    } catch (err) {
      console.error('❌ MEV detection error:', err.message);
      return { riskScore: 0.5, recommendation: 'medium' };
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
    const config = {
      low: { chunks: 2, variance: 0.1 },
      medium: { chunks: 3, variance: 0.2 },
      high: { chunks: 5, variance: 0.3 }
    };
    const { chunks, variance } = config[protection];
    const baseSize = amount / chunks;
    const sizes = [];

    for (let i = 0; i < chunks; i++) {
      const randomFactor = 1 + (Math.random() - 0.5) * variance;
      sizes.push(baseSize * randomFactor);
    }

    const total = sizes.reduce((sum, size) => sum + size, 0);
    const adjusted = sizes.map(size => (size / total) * amount);

    console.log(`✂️ Transaction split (${protection}):`, adjusted);
    return adjusted;
  }

  generateDelays(count, protection = 'medium') {
    const config = {
      low: { min: 100, max: 1000 },
      medium: { min: 200, max: 2000 },
      high: { min: 500, max: 3000 }
    };
    const { min, max } = config[protection];
    const delays = Array.from({ length: count }, () =>
      Math.floor(Math.random() * (max - min) + min)
    );
    console.log(`⏱️ Generated delays (${protection}):`, delays);
    return delays;
  }
}

const mevProtection = new MEVProtection();




      
    

// === MULTI-WALLET ORCHESTRATION ===
// === MULTI-WALLET ORCHESTRATION (improved) ===
class MultiWalletOrchestrator {
  constructor(keysEnv) {
    this.wallets = [];
    this.loadWallets(keysEnv);
  }

  loadWallets(keysEnv) {
    try {
      // Always include the main payer as the first wallet
      this.wallets.push({
        keypair: payer,
        role: 'main',
        active: true,
        balance: 0
      });
      log('💼 Main payer wallet added:', payer.publicKey.toString());

      if (!keysEnv) {
        log('ℹ️ No WALLET_KEYS provided — running single-wallet mode.');
      } else {
        const keys = keysEnv.split(',').map(k => k.trim()).filter(Boolean);
        for (let i = 0; i < keys.length; i++) {
          const raw = keys[i];
          try {
            const secret = bs58.decode(raw);
            if (secret.length !== 64) {
              warn(`Wallet key #${i + 1} decoded but unexpected secret length=${secret.length}; skipping.`);
              continue;
            }
            const keypair = Keypair.fromSecretKey(secret);
            this.wallets.push({
              keypair,
              role: `wallet_${i + 1}`,
              active: true,
              balance: 0
            });
            log(`✅ Loaded wallet ${i + 1}: ${keypair.publicKey.toString().slice(0, 8)}...`);
          } catch (err) {
            warn(`❌ Failed to load wallet #${i + 1} (skipping):`, err.message || err);
            continue;
          }
        }
      }

      log(`🎭 Multi-wallet system initialized: ${this.wallets.length} wallets (active: ${this.getActiveWallets().length})`);
    } catch (err) {
      error('💥 Unexpected error while loading wallets:', err);
      // Ensure at least the payer exists
      if (this.wallets.length === 0) {
        this.wallets.push({
          keypair: payer,
          role: 'main',
          active: true,
          balance: 0
        });
        log('⚠️ Fallback: added payer as single wallet.');
      }
    }
  }

  getActiveWallets() {
    return this.wallets.filter(w => w && w.active);
  }

  distributeAmount(totalAmount, walletCount = null) {
    const active = this.getActiveWallets();
    const walletsToUse = walletCount || Math.min(active.length, 3);
    if (walletsToUse <= 0) return [];

    const amounts = [];
    let remaining = totalAmount;

    // Create (walletsToUse - 1) random splits and place remainder in last
    for (let i = 0; i < walletsToUse - 1; i++) {
      // keep the split reasonable (20% - 40%)
      const percentage = 0.2 + Math.random() * 0.2;
      const amount = +(remaining * percentage).toFixed(8);
      amounts.push(amount);
      remaining -= amount;
    }
    amounts.push(+remaining.toFixed(8));
    // shuffle to avoid predictable ordering
    for (let i = amounts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [amounts[i], amounts[j]] = [amounts[j], amounts[i]];
    }
    log('🔀 Distributed amounts across wallets:', amounts);
    return amounts;
  }

  generateNaturalDelays(count) {
    if (count <= 0) return [];
    const delays = Array.from({ length: count }, () => {
      const baseDelay = 500 + Math.random() * 7500;
      const clustering = Math.random() < 0.3 ? Math.random() * 2000 : 0;
      return Math.floor(baseDelay + clustering);
    });
    log('⏱️ Natural delays generated (ms):', delays);
    return delays;
  }

  async executeCoordinatedBuy(mint, totalAmount, protection = true) {
    const active = this.getActiveWallets();
    const walletsToUse = Math.min(active.length, 3);
    if (walletsToUse <= 0) {
      throw new Error('No active wallets available for coordinated buy');
    }

    const amounts = this.distributeAmount(totalAmount, walletsToUse);
    const delays = this.generateNaturalDelays(walletsToUse - 1);

    log(`🎭 Coordinated buy start — wallets:${walletsToUse}, total:${totalAmount} SOL, protection:${!!protection}`);

    const results = [];

    for (let i = 0; i < walletsToUse; i++) {
      const walletObj = active[i];
      const amount = amounts[i];

      if (!walletObj || !walletObj.keypair) {
        warn(`⚠️ Skipping missing wallet at index ${i}`);
        results.push({ wallet: `unknown_${i}`, amount, error: 'Missing wallet' });
        continue;
      }

      try {
        log(`🔄 [Wallet ${i + 1}] ${walletObj.keypair.publicKey.toString().slice(0,8)} buying ${amount} SOL`);
        const tx = await this.executeBuyWithWallet(walletObj, mint, amount, protection);
        results.push({ wallet: walletObj.role, amount, tx });
        log(`✅ [Wallet ${i + 1}] buy result:`, tx);
      } catch (err) {
        error(`❌ [Wallet ${i + 1}] buy failed:`, err && err.message ? err.message : err);
        results.push({ wallet: walletObj.role, amount, error: err && err.message ? err.message : String(err) });
      }

      if (i < walletsToUse - 1) {
        const d = delays[i] || 1000;
        log(`⏳ Waiting ${d}ms before next wallet buy`);
        await new Promise(res => setTimeout(res, d));
      }
    }

    log('🎭 Coordinated buy finished. Summary:', results);
    return results;
  }

  async executeBuyWithWallet(walletObj, mint, solAmount, mevProtection = true) {
    if (!mint) throw new Error('executeBuyWithWallet: mint is required');
    if (!walletObj || !walletObj.keypair) throw new Error('executeBuyWithWallet: invalid wallet object');

    // 1) fetch pool (with a short timeout wrapper)
    let pool;
    try {
      log('🌐 Fetching Raydium pool info for', mint);
      pool = await Promise.race([
        getRaydiumPoolInfo(mint),
        new Promise((_, rej) => setTimeout(() => rej(new Error('getRaydiumPoolInfo timeout (8s)')), 8000))
      ]);
      if (!pool) throw new Error('No pool found');
      log('✅ Pool found:', pool.id || '(no id)', pool.baseMint === mint ? 'base' : 'quote');
    } catch (err) {
      throw new Error(`Failed to get pool for mint ${mint}: ${err.message || err}`);
    }

    const WSOL = 'So11111111111111111111111111111111111111112';
    const wallet = walletObj.keypair;
    const amountIn = Math.floor(solAmount * LAMPORTS_PER_SOL);
    if (amountIn <= 0) throw new Error('Amount too small');

    // 2) ensure WSOL ATA exists
    let userWSOL;
    try {
      userWSOL = await getAssociatedTokenAddress(new PublicKey(WSOL), wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    } catch (err) {
      throw new Error('Failed to compute WSOL ATA: ' + (err.message || err));
    }

    try {
      const wsolInfo = await connection.getAccountInfo(userWSOL);
      if (!wsolInfo) {
        log('🧩 Creating WSOL ATA for wallet', wallet.publicKey.toString().slice(0,8));
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
        await connection.sendTransaction(createTx, [wallet]);
        log('✅ WSOL ATA created');
      }
    } catch (err) {
      throw new Error('Failed ensuring WSOL ATA: ' + (err.message || err));
    }

    // 3) wrap SOL (transfer lamports into WSOL ATA) and sync
    try {
      log(`💸 Wrapping ${solAmount} SOL -> ${amountIn} lamports for wallet ${wallet.publicKey.toString().slice(0,8)}`);
      const wrapTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: userWSOL,
          lamports: amountIn
        }),
        createSyncNativeInstruction(userWSOL)
      );

      if (mevProtection) {
        log('🛡️ Sending wrap using private transaction (MEV protection)');
        await sendPrivateTransactionWithWallet(wrapTx, wallet);
      } else {
        await connection.sendTransaction(wrapTx, [wallet]);
      }
      log('✅ Wrapped SOL completed');
    } catch (err) {
      throw new Error('Failed to wrap SOL: ' + (err.message || err));
    }

    // 4) ensure output ATA exists
    const toMint = (pool.baseMint === mint) ? mint : WSOL;
    let userOutATA;
    try {
      userOutATA = await getAssociatedTokenAddress(new PublicKey(toMint), wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const outInfo = await connection.getAccountInfo(userOutATA);
      if (!outInfo) {
        log('🧩 Creating output ATA for mint:', toMint);
        const createOutTx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            userOutATA,
            wallet.publicKey,
            new PublicKey(toMint),
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
        await connection.sendTransaction(createOutTx, [wallet]);
        log('✅ Output ATA created');
      }
    } catch (err) {
      throw new Error('Failed ensuring output ATA: ' + (err.message || err));
    }

    // 5) build swap instruction and execute
    try {
      log('🔁 Building Raydium swap instruction...');
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
        direction: pool.baseMint === mint ? 'quote2base' : 'base2quote'
      });

      const swapTx = new Transaction();
      if (swapIx && Array.isArray(swapIx.innerTransactions)) {
        swapIx.innerTransactions.forEach(({ instructions }) =>
          instructions.forEach(ix => swapTx.add(ix))
        );
      } else if (swapIx && swapIx.instructions) {
        swapIx.instructions.forEach(ix => swapTx.add(ix));
      } else {
        // If Raydium SDK shape differs, still try to add top-level instructions
        if (swapIx && swapIx.length) {
          swapIx.forEach(ix => swapTx.add(ix));
        }
      }

      // send
      log('🚀 Sending swap transaction (mevProtection=' + !!mevProtection + ')');
      if (mevProtection) {
        return await sendPrivateTransactionWithWallet(swapTx, wallet);
      } else {
        return await connection.sendTransaction(swapTx, [wallet]);
      }
    } catch (err) {
      throw new Error('Swap execution failed: ' + (err.message || err));
    }
  }
}

// Initialize singletons
const mevProtection = new MEVProtection();
const multiWallet = new MultiWalletOrchestrator(WALLET_KEYS);
log(`🎭 Multi-wallet orchestrator ready — ${multiWallet.getActiveWallets().length} active wallets.`);

  
  
      
// === BASIC HELPER FUNCTIONS ===
// === BASIC HELPER FUNCTIONS (improved with logs + validation) ===

async function getRaydiumPoolInfo(mintAddress) {
  if (!mintAddress || typeof mintAddress !== 'string') {
    throw new Error('getRaydiumPoolInfo: mintAddress must be a non-empty string');
  }

  try {
    log(`🌐 Fetching Raydium pools for mint: ${mintAddress.slice(0, 8)}...`);

    const url = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
    const pools = await Promise.race([
      fetch(url).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Timeout fetching Raydium pools')), 8000)
      )
    ]);

    // Search official pools first
    for (const sid in pools.official) {
      const pool = pools.official[sid];
      if (pool.baseMint === mintAddress || pool.quoteMint === mintAddress) {
        pool.id = sid;
        log(`✅ Found official Raydium pool: ${sid}`);
        return pool;
      }
    }

    // Then unofficial pools
    for (const sid in pools.unOfficial) {
      const pool = pools.unOfficial[sid];
      if (pool.baseMint === mintAddress || pool.quoteMint === mintAddress) {
        pool.id = sid;
        log(`✅ Found unofficial Raydium pool: ${sid}`);
        return pool;
      }
    }

    throw new Error(`No Raydium pool found for mint: ${mintAddress}`);
  } catch (err) {
    error('❌ getRaydiumPoolInfo failed:', err.message || err);
    throw err;
  }
}

async function getATA(mint, owner) {
  if (!mint || !owner) {
    throw new Error('getATA: mint and owner are required');
  }

  try {
    return await getAssociatedTokenAddress(
      new PublicKey(mint),
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  } catch (err) {
    error('❌ Failed to compute ATA:', err.message || err);
    throw err;
  }
}

async function ensureATA(mint, owner) {
  if (!mint || !owner) {
    throw new Error('ensureATA: mint and owner are required');
  }

  try {
    const ata = await getATA(mint, owner);
    const info = await connection.getAccountInfo(ata);

    if (!info) {
      log(`🧩 Creating ATA for mint ${mint.slice(0, 8)}... and owner ${owner.toString().slice(0, 8)}...`);
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          ata,
          owner,
          new PublicKey(mint),
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );

      const sig = await connection.sendTransaction(tx, [payer], {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      });
      log(`✅ ATA created. Tx: ${sig}`);
    } else {
      log(`ℹ️ ATA already exists for mint ${mint.slice(0, 8)}...`);
    }

    return ata;
  } catch (err) {
    error('❌ ensureATA failed:', err.message || err);
    throw err;
  }
                      }

// === MEV-PROTECTED TRADING FUNCTIONS ===
// === MEV-PROTECTED TRADING FUNCTIONS (hardened + logged) ===

/**
 * Helper: fetch with timeout (node-fetch)
 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
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

/**
 * Send transaction via Jito private pool, fallback to public RPC.
 * Returns signature string on success (or result from Jito).
 */
async function sendPrivateTransaction(transaction, tip = 10000) {
  try {
    const tipAmount = Number(JITO_TIP) || tip;
    if (tipAmount > 0) {
      try {
        const tipInstruction = SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
          lamports: tipAmount
        });
        transaction.add(tipInstruction);
      } catch (e) {
        warn('Could not add tip instruction:', e.message || e);
      }
    }

    const jitoEndpoint = MEV_CONFIG.privatePools[Math.floor(Math.random() * MEV_CONFIG.privatePools.length)];
    log('🚀 Attempting to send via Jito endpoint:', jitoEndpoint);

    try {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          transaction.serialize({ requireAllSignatures: false }).toString('base64'),
          { skipPreflight: false, preflightCommitment: 'confirmed' }
        ]
      };

      const resp = await fetchWithTimeout(`${jitoEndpoint}/api/v1/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }, 8000);

      if (!resp.ok) {
        warn('Jito responded with non-OK status:', resp.status);
        throw new Error(`Jito HTTP ${resp.status}`);
      }

      const result = await resp.json();
      if (result?.result) {
        log('✅ Transaction accepted via Jito:', result.result);
        return result.result;
      } else {
        warn('⚠️ Jito returned no result, falling back', result);
        throw new Error('Jito returned no result');
      }
    } catch (jitoErr) {
      warn('⚠️ Jito send failed, falling back to RPC:', jitoErr.message || jitoErr);
    }

    // fallback to connection.sendTransaction
    log('📡 Sending via public RPC (connection.sendTransaction)...');
    const sig = await connection.sendTransaction(transaction, [payer], {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });
    log('✅ Sent via RPC, sig:', sig);
    return sig;
  } catch (err) {
    error('💥 sendPrivateTransaction failed:', err);
    throw err;
  }
}

/**
 * Same as above but signs with provided wallet Keypair
 */
async function sendPrivateTransactionWithWallet(transaction, wallet, tip = 10000) {
  try {
    const tipAmount = Number(JITO_TIP) || tip;
    if (tipAmount > 0) {
      try {
        const tipInstruction = SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
          lamports: tipAmount
        });
        transaction.add(tipInstruction);
      } catch (e) {
        warn('Could not add tip instruction (wallet):', e.message || e);
      }
    }

    const jitoEndpoint = MEV_CONFIG.privatePools[Math.floor(Math.random() * MEV_CONFIG.privatePools.length)];
    log('🚀 Attempting wallet send via Jito endpoint:', jitoEndpoint);

    try {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          transaction.serialize({ requireAllSignatures: false }).toString('base64'),
          { skipPreflight: false, preflightCommitment: 'confirmed' }
        ]
      };

      const resp = await fetchWithTimeout(`${jitoEndpoint}/api/v1/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }, 8000);

      if (!resp.ok) {
        warn('Jito wallet send responded non-OK:', resp.status);
        throw new Error(`Jito wallet HTTP ${resp.status}`);
      }

      const result = await resp.json();
      if (result?.result) {
        log('✅ Wallet transaction accepted via Jito:', result.result);
        return result.result;
      } else {
        warn('⚠️ Jito wallet returned no result, falling back', result);
        throw new Error('Jito wallet returned no result');
      }
    } catch (jitoErr) {
      warn('⚠️ Jito wallet send failed, falling back to RPC:', jitoErr.message || jitoErr);
    }

    // fallback to connection.sendTransaction with wallet
    log('📡 Sending wallet tx via public RPC (connection.sendTransaction)...');
    const sig = await connection.sendTransaction(transaction, [wallet], {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });
    log('✅ Wallet tx sent via RPC, sig:', sig);
    return sig;
  } catch (err) {
    error('💥 sendPrivateTransactionWithWallet failed:', err);
    throw err;
  }
}

/**
 * MEV-protected buy (splits + delay) — returns array of tx signatures (or values returned by send functions)
 */
async function buyTokenMEVProtected(mint, solAmount) {
  if (!mint) throw new Error('buyTokenMEVProtected: mint required');
  if (!Number.isFinite(solAmount) || solAmount <= 0) throw new Error('buyTokenMEVProtected: invalid solAmount');

  log(`🛡️ Starting MEV-protected buy: ${solAmount} SOL for ${mint}`);
  const mevAnalysis = await mevProtection.detectMEVActivity(mint);
  const protection = mevAnalysis.recommendation || 'medium';
  log(`🔍 MEV risk ${mevAnalysis.riskScore} => ${protection}`);

  const chunks = mevProtection.splitTransaction(solAmount, protection);
  const delays = mevProtection.generateDelays(Math.max(0, chunks.length - 1), protection);

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const chunk = chunks[i];
      log(`🔄 Executing chunk ${i + 1}/${chunks.length}: ${chunk.toFixed(6)} SOL`);
      const tx = await buyTokenSingle(mint, chunk);
      results.push(tx);
      log(`✅ Chunk ${i + 1} done: ${tx}`);
    } catch (err) {
      error(`❌ Chunk ${i + 1} failed:`, err.message || err);
      results.push({ error: err.message || String(err) });
    }

    if (i < delays.length) {
      const d = delays[i];
      log(`⏳ Waiting ${d}ms before next chunk`);
      await new Promise(r => setTimeout(r, d));
    }
  }

  return results;
}

/**
 * Single buy: ensures ATAs, wraps SOL (if necessary), builds swap, sends tx.
 * Returns signature or throw.
 */
async function buyTokenSingle(mint, solAmount) {
  if (!mint) throw new Error('buyTokenSingle: mint required');
  if (!Number.isFinite(solAmount) || solAmount <= 0) throw new Error('buyTokenSingle: invalid solAmount');

  log(`🔎 buyTokenSingle: mint=${mint}, sol=${solAmount}`);

  // 1) get pool info (with timeout via wrapper already used)
  const pool = await Promise.race([
    getRaydiumPoolInfo(mint),
    new Promise((_, rej) => setTimeout(() => rej(new Error('getRaydiumPoolInfo timeout')), 8000))
  ]).catch(err => {
    throw new Error('buyTokenSingle: failed to fetch pool info: ' + (err.message || err));
  });

  const buyingBase = (pool.baseMint === mint);
  const WSOL = 'So11111111111111111111111111111111111111112';
  const amountIn = Math.floor(solAmount * LAMPORTS_PER_SOL);
  if (amountIn <= 0) throw new Error('buyTokenSingle: amountIn too small');

  // 2) ensure WSOL ATA exists for payer
  const userWSOL = await ensureATA(WSOL, payer.publicKey);

  // 3) check balance and wrap SOL if needed
  try {
    const rawBalance = await connection.getTokenAccountBalance(userWSOL);
    const wsolBalance = Number(rawBalance?.value?.amount || 0);
    log(`💰 WSOL balance for payer: ${wsolBalance} (need ${amountIn})`);

    if (wsolBalance < amountIn) {
      log(`💸 Wrapping ${solAmount} SOL (${amountIn} lamports) for payer`);
      const wrapTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: userWSOL,
          lamports: amountIn
        }),
        createSyncNativeInstruction(userWSOL)
      );
      await sendPrivateTransaction(wrapTx);
      log('✅ Wrap completed');
    }
  } catch (err) {
    warn('⚠️ Could not check/wrap WSOL balance:', err.message || err);
    // attempt wrap anyway
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: userWSOL,
        lamports: amountIn
      }),
      createSyncNativeInstruction(userWSOL)
    );
    await sendPrivateTransaction(wrapTx);
  }

  // 4) ensure output ATA exists
  const toMint = buyingBase ? mint : WSOL;
  const userOutATA = await ensureATA(toMint, payer.publicKey);

  // 5) build swap instruction (tolerate different shapes)
  let swapIx;
  try {
    swapIx = await buildSwapInstruction({
      poolKeys: pool,
      userKeys: {
        tokenAccountIn: userWSOL,
        tokenAccountOut: userOutATA,
        owner: payer.publicKey,
        payer: payer.publicKey
      },
      amountIn,
      minAmountOut: 1,
      direction: buyingBase ? 'quote2base' : 'base2quote'
    });
  } catch (err) {
    throw new Error('buyTokenSingle: buildSwapInstruction failed: ' + (err.message || err));
  }

  // 6) assemble transaction (handles different SDK return shapes)
  const tx = new Transaction();
  try {
    if (swapIx?.innerTransactions && Array.isArray(swapIx.innerTransactions)) {
      swapIx.innerTransactions.forEach(t => (t.instructions || []).forEach(ix => tx.add(ix)));
    } else if (Array.isArray(swapIx?.instructions)) {
      swapIx.instructions.forEach(ix => tx.add(ix));
    } else if (Array.isArray(swapIx)) {
      swapIx.forEach(ix => tx.add(ix));
    } else {
      throw new Error('buyTokenSingle: unexpected swapIx shape');
    }
  } catch (err) {
    throw new Error('buyTokenSingle: failed to compose swap tx: ' + (err.message || err));
  }

  // 7) send transaction via private pool / fallback
  try {
    const sig = await sendPrivateTransaction(tx);
    log('✅ buyTokenSingle tx signature:', sig);
    return sig;
  } catch (err) {
    throw new Error('buyTokenSingle: send failed: ' + (err.message || err));
  }
}

/**
 * MEV-protected sell (splits) — returns array of tx sigs/results
 */
async function sellTokenMEVProtected(mint, sellPct) {
  if (!mint) throw new Error('sellTokenMEVProtected: mint required');
  if (!Number.isFinite(sellPct) || sellPct <= 0 || sellPct > 100) throw new Error('sellTokenMEVProtected: invalid sellPct');

  log(`🛡️ sellTokenMEVProtected: ${sellPct}% for ${mint}`);
  const analysis = await mevProtection.detectMEVActivity(mint);
  const protection = analysis.recommendation || 'medium';

  if (sellPct === 100 || protection === 'high') {
    return [await sellTokenSingle(mint, sellPct)];
  }

  const chunks = Math.min(3, Math.ceil(sellPct / 25));
  const chunkPct = sellPct / chunks;
  const delays = mevProtection.generateDelays(Math.max(0, chunks - 1), protection);

  const results = [];
  for (let i = 0; i < chunks; i++) {
    try {
      const tx = await sellTokenSingle(mint, chunkPct);
      results.push(tx);
      log(`✅ Sell chunk ${i + 1} sig: ${tx}`);
    } catch (err) {
      error(`❌ Sell chunk ${i + 1} failed:`, err.message || err);
      results.push({ error: err.message || String(err) });
    }
    if (i < delays.length) await new Promise(r => setTimeout(r, delays[i]));
  }
  return results;
}

/**
 * Single sell: computes amount based on wallet balance and executes swap.
 * Returns signature.
 */
async function sellTokenSingle(mint, sellPct) {
  if (!mint) throw new Error('sellTokenSingle: mint required');
  if (!Number.isFinite(sellPct) || sellPct <= 0) throw new Error('sellTokenSingle: invalid sellPct');

  log(`🔎 sellTokenSingle: mint=${mint}, pct=${sellPct}`);

  const pool = await Promise.race([
    getRaydiumPoolInfo(mint),
    new Promise((_, rej) => setTimeout(() => rej(new Error('getRaydiumPoolInfo timeout')), 8000))
  ]).catch(err => {
    throw new Error('sellTokenSingle: failed to fetch pool info: ' + (err.message || err));
  });

  const baseMint = pool.baseMint;
  const WSOL = 'So11111111111111111111111111111111111111112';

  // Ensure ATAs
  const userBaseATA = await ensureATA(baseMint, payer.publicKey);
  const userWSOL = await ensureATA(WSOL, payer.publicKey);

  // Get token balance and compute amount to sell
  let rawBal;
  try {
    rawBal = await connection.getTokenAccountBalance(userBaseATA);
  } catch (err) {
    throw new Error('sellTokenSingle: failed to get token balance: ' + (err.message || err));
  }

  const bal = Number(rawBal?.value?.amount || 0);
  const amountIn = Math.floor(bal * (sellPct / 100));
  if (amountIn < 1) {
    throw new Error('sellTokenSingle: Not enough token balance to sell');
  }

  // Build swap
  let swapIx;
  try {
    swapIx = await buildSwapInstruction({
      poolKeys: pool,
      userKeys: {
        tokenAccountIn: userBaseATA,
        tokenAccountOut: userWSOL,
        owner: payer.publicKey,
        payer: payer.publicKey
      },
      amountIn,
      minAmountOut: 1,
      direction: 'base2quote'
    });
  } catch (err) {
    throw new Error('sellTokenSingle: buildSwapInstruction failed: ' + (err.message || err));
  }

  // Compose tx
  const tx = new Transaction();
  try {
    if (swapIx?.innerTransactions && Array.isArray(swapIx.innerTransactions)) {
      swapIx.innerTransactions.forEach(t => (t.instructions || []).forEach(ix => tx.add(ix)));
    } else if (Array.isArray(swapIx?.instructions)) {
      swapIx.instructions.forEach(ix => tx.add(ix));
    } else if (Array.isArray(swapIx)) {
      swapIx.forEach(ix => tx.add(ix));
    } else {
      throw new Error('sellTokenSingle: unexpected swapIx shape');
    }
  } catch (err) {
    throw new Error('sellTokenSingle: failed to compose swap tx: ' + (err.message || err));
  }

  try {
    const sig = await sendPrivateTransaction(tx);
    log('✅ sellTokenSingle tx sig:', sig);
    return sig;
  } catch (err) {
    throw new Error('sellTokenSingle: send failed: ' + (err.message || err));
  }
  }





    
        
  

// === MENU HELPERS ===
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

function clearUserSetup(userId) {
  setupFlow.users.delete(userId);
  setupFlow.data.delete(userId);
}

function getCurrentStep(userId) {
  return setupFlow.users.get(userId);
}

function setUserStep(userId, step) {
  setupFlow.users.set(userId, step);
}

function getUserData(userId) {
  if (!setupFlow.data.has(userId)) {
    setupFlow.data.set(userId, {});
  }
  return setupFlow.data.get(userId);
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

// === TELEGRAM HANDLERS ===
bot.start(ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const welcomeMsg = [
    '🤖 **Welcome to Net-Buy-Pumpet!**',
    '',
    '🚀 **Professional Solana Token Pump Bot**',
    '💎 Automated buying/selling with Raydium integration',
    '🛡️ MEV Protection & Multi-Wallet Orchestration',
    '',
    '📊 **Current Status:**',
    `🎯 Token: ${session.mint ? `${session.mint.slice(0, 8)}...` : '❌ Not configured'}`,
    `🔄 Bot: ${running ? '🟢 Active' : '🔴 Stopped'}`,
    `🎭 Wallets: ${multiWallet.getActiveWallets().length} loaded`,
    '',
    '👇 **Choose an action below:**'
  ].join('\n');

  ctx.reply(welcomeMsg, { ...getMainMenu(), parse_mode: 'Markdown' });
});

bot.command('setup', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  clearUserSetup(ctx.from.id);
  setUserStep(ctx.from.id, SETUP_STEPS.WAITING_CONTRACT);

  ctx.reply(
    '🔧 **Pump Setup - Step 1/5**\n\n' +
    '🎯 **Enter Token Contract Address:**\n' +
    '📝 Please send the contract address (mint) of the token you want to pump.\n\n' +
    '💡 Example: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`',
    { ...getSetupMenu(), parse_mode: 'Markdown' }
  );
});

bot.command('status', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const statusMsg = [
    showCurrentConfig(),
    '',
    `🔄 **Bot Status:** ${running ? '🟢 Pumping Active' : '🔴 Stopped'}`,
    `🌐 **Connection:** ${rpcEndpoint}`,
    `👤 **Main Wallet:** ${payer.publicKey.toString().slice(0, 8)}...`
  ].join('\n');

  ctx.reply(statusMsg, { ...getStatusMenu(), parse_mode: 'Markdown' });
});

bot.command('advanced', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const advancedMsg = [
    '🛡️ **Advanced Features Control**',
    '',
    '🎛️ **Current Settings:**',
    `🛡️ MEV Protection: ${session.mevProtection ? '🟢 ON' : '🔴 OFF'}`,
    `🎭 Multi-Wallet: ${session.multiWallet ? '🟢 ON' : '🔴 OFF'}`,
    '',
    '⚙️ **Toggle settings or run analysis below:**'
  ].join('\n');

  ctx.reply(advancedMsg, { ...getAdvancedMenu(), parse_mode: 'Markdown' });
});

bot.command('help', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const helpMsg = [
    '�� **Net-Buy-Pumpet Help**',
    '',
    '🚀 **Bot Commands:**',
    '• `/start` - Main dashboard',
    '• `/setup` - Configure pump parameters',
    '• `/status` - View current configuration',
    '• `/advanced` - Advanced feature controls',
    '• `/pump` - Start pumping',
    '• `/stop` - Stop pumping',
    '• `/sellall` - Sell all tokens',
    '• `/help` - Show this help',
    '',
    '🔧 **How to Use:**',
    '1. Click "Setup Configuration" to configure your pump',
    '2. Follow the 5-step setup process',
    '3. Enable advanced features with `/advanced`',
    '4. Click "Start Pump" to begin trading',
    '5. Monitor transactions in real-time',
    '',
    '💡 **Advanced Features:**',
    '• 🛡️ MEV Protection - Jito private mempool',
    '• 🎭 Multi-Wallet - Coordinate multiple wallets'
  ].join('\n');

  ctx.reply(helpMsg, { ...getMainMenu(), parse_mode: 'Markdown' });
});

// Handle the streamlined setup flow

// Utility: Validate Solana address
function isValidSolanaAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

bot.on('text', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const userId = ctx.from.id;
  const currentStep = getCurrentStep(userId);
  const text = ctx.message.text.trim();

  console.log(`📩 Message from ${userId}: "${text}" | Step: ${currentStep || 'NONE'}`);

  if (!currentStep) {
    if (text && !text.startsWith('/')) {
      ctx.reply(
        '🤖 **Use the menu buttons below or send `/help` for available commands.**',
        getMainMenu()
      );
    }
    return;
  }

  const userData = getUserData(userId);

  try {
    switch (currentStep) {
      case SETUP_STEPS.WAITING_CONTRACT:
        console.log("🔧 Setup Step 1: Contract address entered:", text);

        if (!isValidSolanaAddress(text)) {
          console.log("❌ Invalid Solana address format");
          return ctx.reply(
            '❌ Invalid contract address. Please enter a valid Solana token mint address.',
            getSetupMenu()
          );
        }

        try {
          await getRaydiumPoolInfo(text);
          userData.mint = text;
          setUserStep(userId, SETUP_STEPS.WAITING_SOL_AMOUNT);

          console.log("✅ Token found on Raydium:", text);

          ctx.reply(
            '✅ **Token Found!**\n\n' +
            '🔧 **Setup - Step 2/5**\n\n' +
            '💰 **Enter SOL Amount per Buy:**\n' +
            '📝 How much SOL to spend on each buy?\n\n' +
            '💡 Examples: `0.1`, `0.5`, `1.0`',
            { ...getSetupMenu(), parse_mode: 'Markdown' }
          );
        } catch (err) {
          console.error("❌ Raydium lookup failed:", err);
          return ctx.reply(
            '❌ Could not verify this token on Raydium pools. Please try another contract.',
            getSetupMenu()
          );
        }
        break;

      case SETUP_STEPS.WAITING_SOL_AMOUNT:
        console.log("🔧 Setup Step 2: SOL amount entered:", text);

        const solAmount = parseFloat(text);
        if (isNaN(solAmount) || solAmount <= 0 || solAmount > 100) {
          console.log("❌ Invalid SOL amount:", text);
          return ctx.reply(
            '❌ Invalid SOL amount. Please enter a number between 0.01 and 100.',
            getSetupMenu()
          );
        }

        userData.buySol = solAmount;
        setUserStep(userId, SETUP_STEPS.WAITING_SELL_PCT);

        ctx.reply(
          '✅ **SOL Amount Set!**\n\n' +
          '🔧 **Setup - Step 3/5**\n\n' +
          '📈 **Enter Sell Percentage:**\n' +
          '📝 What % of tokens to sell after each buy cycle?\n\n' +
          '💡 Examples: `0` (no selling), `25`, `50`, `100`',
          { ...getSetupMenu(), parse_mode: 'Markdown' }
        );
        break;

      case SETUP_STEPS.WAITING_SELL_PCT:
        console.log("🔧 Setup Step 3: Sell percentage entered:", text);

        const sellPct = parseInt(text);
        if (isNaN(sellPct) || sellPct < 0 || sellPct > 100) {
          console.log("❌ Invalid sell percentage:", text);
          return ctx.reply(
            '❌ Invalid percentage. Please enter a number between 0 and 100.',
            getSetupMenu()
          );
        }

        userData.sellPct = sellPct;
        setUserStep(userId, SETUP_STEPS.WAITING_DELAY);

        ctx.reply(
          '✅ **Sell Percentage Set!**\n\n' +
          '🔧 **Setup - Step 4/5**\n\n' +
          '⏱️ **Enter Delay Between Rounds:**\n' +
          '📝 How many seconds to wait between buy cycles?\n\n' +
          '💡 Examples: `1`, `5`, `10` (minimum: 1 second)',
          { ...getSetupMenu(), parse_mode: 'Markdown' }
        );
        break;

      case SETUP_STEPS.WAITING_DELAY:
        console.log("🔧 Setup Step 4: Delay entered:", text);

        const delay = parseInt(text);
        if (isNaN(delay) || delay < 1 || delay > 300) {
          console.log("❌ Invalid delay:", text);
          return ctx.reply(
            '❌ Invalid delay. Please enter a number between 1 and 300 seconds.',
            getSetupMenu()
          );
        }

        userData.delaySec = delay;
        setUserStep(userId, SETUP_STEPS.WAITING_MULTI_BUYS);

        ctx.reply(
          '✅ **Delay Set!**\n\n' +
          '🔧 **Setup - Step 5/5**\n\n' +
          '🔄 **Enter Multi-Buys per Cycle:**\n' +
          '📝 How many buys to execute in each cycle?\n\n' +
          '💡 Examples: `1` (single buy), `3`, `5` (max: 10)',
          { ...getSetupMenu(), parse_mode: 'Markdown' }
        );
        break;

      case SETUP_STEPS.WAITING_MULTI_BUYS:
        console.log("🔧 Setup Step 5: Multi-buys entered:", text);

        const multiBuys = parseInt(text);
        if (isNaN(multiBuys) || multiBuys < 1 || multiBuys > 10) {
          console.log("❌ Invalid multi-buys:", text);
          return ctx.reply(
            '❌ Invalid number. Please enter between 1 and 10 buys per cycle.',
            getSetupMenu()
          );
        }

        userData.multiBuys = multiBuys;
        setUserStep(userId, SETUP_STEPS.CONFIRMATION);

        const confirmationKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirm & Save', 'confirm_setup')],
          [Markup.button.callback('❌ Cancel Setup', 'cancel_setup')],
          [Markup.button.callback('🔄 Start Over', 'start_setup')],
          [Markup.button.callback('🏠 Main Menu', 'main_menu')]
        ]);

        console.log("✅ Setup complete for user:", userId, userData);

        ctx.reply(
          '🎉 **Setup Complete!**\n\n' +
          getSetupSummary(userData) + '\n\n' +
          '✅ Ready to save configuration?',
          { ...confirmationKeyboard, parse_mode: 'Markdown' }
        );
        break;
    }
  } catch (err) {
    console.error("❌ Setup flow error:", err);
    ctx.reply(
      `❌ Setup error: ${err.message}\n\nPlease try again or cancel setup.`,
      getSetupMenu()
    );
    clearUserSetup(userId);
  }
});

      

// === BUTTON HANDLERS ===
// === BUTTON HANDLERS WITH LOGGING ===
bot.action(/.*/, async ctx => {
  if (ctx.from.id.toString() !== ADMIN) {
    console.log(`🚫 Unauthorized button press from ${ctx.from.id}, ignored.`);
    return ctx.answerCbQuery('Not allowed.');
  }

  const action = ctx.callbackQuery.data;
  console.log(`📩 Button pressed: ${action} by ${ctx.from.id}`);

  try {
    switch (action) {
      case 'main_menu': {
        console.log("📊 Rendering main menu with session:", session);
        const welcomeMsg = [
          '🤖 **Net-Buy-Pumpet Dashboard**',
          '',
          '📊 **Current Status:**',
          `🎯 Token: ${session.mint ? `${session.mint.slice(0, 8)}...` : '❌ Not configured'}`,
          `💰 Buy: ${session.buySol} SOL per cycle`,
          `📈 Sell %: ${session.sellPct}%`,
          `⏱️ Delay: ${session.delaySec}s`,
          `🔄 Multi-Buys: ${session.multiBuys}`,
          `🤖 Status: ${running ? '🟢 Pumping Active' : '🔴 Stopped'}`,
          `🎭 Wallets: ${multiWallet.getActiveWallets().length} loaded`,
          '',
          '👇 **Choose an action:**'
        ].join('\n');
        await ctx.editMessageText(welcomeMsg, { ...getMainMenu(), parse_mode: 'Markdown' });
        break;
      }

      case 'advanced_menu': {
        console.log("⚙️ Showing advanced menu");
        const advancedMsg = [
          '🛡️ **Advanced Features Control**',
          '',
          '🎛️ **Current Settings:**',
          `🛡️ MEV Protection: ${session.mevProtection ? '🟢 ON' : '🔴 OFF'}`,
          `🎭 Multi-Wallet: ${session.multiWallet ? '🟢 ON' : '🔴 OFF'}`,
          '',
          '⚙️ **Toggle settings or run analysis below:**'
        ].join('\n');
        await ctx.editMessageText(advancedMsg, { ...getAdvancedMenu(), parse_mode: 'Markdown' });
        break;
      }

      case 'start_setup': {
        console.log("📝 Setup started by", ctx.from.id);
        clearUserSetup(ctx.from.id);
        setUserStep(ctx.from.id, SETUP_STEPS.WAITING_CONTRACT);
        await ctx.reply(
          '🔧 **Pump Setup - Step 1/5**\n\n' +
          '🎯 **Enter Token Contract Address:**\n' +
          '📝 Please send the contract address (mint) of the token you want to pump.\n\n' +
          '💡 Example: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`',
          { ...getSetupMenu(), parse_mode: 'Markdown' }
        );
        break;
      }

      case 'confirm_setup': {
        const userData = getUserData(ctx.from.id);
        console.log("✅ Confirming setup for", ctx.from.id, userData);

        if (!userData?.mint || !userData?.buySol) {
          console.warn("⚠️ Incomplete setup, cannot confirm.");
          return ctx.reply('❌ Setup incomplete. Please restart setup.', getSetupMenu());
        }

        session.mint = userData.mint;
        session.buySol = userData.buySol;
        session.sellPct = userData.sellPct;
        session.delaySec = userData.delaySec;
        session.multiBuys = userData.multiBuys;

        clearUserSetup(ctx.from.id);

        await ctx.reply(
          '🎉 **Configuration Saved Successfully!**\n\n' +
          showCurrentConfig() + '\n\n' +
          '🚀 Ready to start pumping?',
          { ...getMainMenu(), parse_mode: 'Markdown' }
        );
        break;
      }

      case 'cancel_setup': {
        console.log("❌ Setup cancelled by", ctx.from.id);
        clearUserSetup(ctx.from.id);
        await ctx.reply(
          '❌ **Setup Cancelled**\n\nUse the menu below to start again or check status.',
          getMainMenu()
        );
        break;
      }

      case 'refresh_status': {
        console.log("🔄 Refreshing status for", ctx.from.id);
        const statusMsg = [
          showCurrentConfig(),
          '',
          `🔄 **Bot Status:** ${running ? '🟢 Pumping Active' : '🔴 Stopped'}`,
          `🌐 **Connection:** ${rpcEndpoint}`,
          `👤 **Main Wallet:** ${payer.publicKey.toString().slice(0, 8)}...`
        ].join('\n');
        await ctx.reply(statusMsg, { ...getStatusMenu(), parse_mode: 'Markdown' });
        break;
      }

      case 'start_pump': {
        if (running) {
          console.log("⚠️ Pump already running");
          return ctx.answerCbQuery('Pump already running!');
        }
        if (!session.mint) {
          console.log("⚠️ Pump start blocked: no token configured");
          return ctx.answerCbQuery('Please complete setup first!');
        }

        console.log("🚀 Pump started with config:", session);
        running = true;
        await ctx.reply(
          '🔥 **PUMP STARTED!**\n\n' +
          `🎯 Token: ${session.mint.slice(0, 8)}...\n` +
          `💰 Buy: ${session.buySol} SOL per cycle\n` +
          `📈 Sell: ${session.sellPct}%\n` +
          `⏱️ Delay: ${session.delaySec}s\n` +
          `🔄 Multi-Buys: ${session.multiBuys}\n` +
          `🛡️ MEV Protection: ${session.mevProtection ? 'ON' : 'OFF'}\n` +
          `🎭 Multi-Wallet: ${session.multiWallet ? 'ON' : 'OFF'}\n`,
          { ...Markup.inlineKeyboard([
              [Markup.button.callback('⏹️ Stop Pump', 'stop_pump')],
              [Markup.button.callback('📊 View Status', 'refresh_status')],
              [Markup.button.callback('💰 Emergency Sell All', 'sell_all_confirm')],
              [Markup.button.callback('🛡️ Advanced Settings', 'advanced_menu')],
              [Markup.button.callback('🏠 Main Menu', 'main_menu')]
          ]), parse_mode: 'Markdown' }
        );
        startPumpLoop(ctx);
        break;
      }

      case 'stop_pump': {
        if (!running) {
          console.log("⚠️ Stop requested but pump not running.");
          return ctx.answerCbQuery('Pump is not running!');
        }
        console.log("🛑 Pump stop requested.");
        running = false;
        await ctx.reply(
          '⏹️ **Pump Stop Requested**\n\nWill stop after current cycle.',
          { ...getMainMenu(), parse_mode: 'Markdown' }
        );
        break;
      }

      case 'sell_all_confirm': {
        if (!session.mint) {
          console.log("⚠️ Sell-all blocked: no token configured.");
          return ctx.answerCbQuery('No token configured!');
        }
        console.log("🚨 Sell-all confirmation requested.");
        await ctx.reply(
          '🚨 **SELL ALL TOKENS**\n\n' +
          `Sell 100% of ${session.mint.slice(0, 8)}...?\n\n⚠️ Cannot be undone!`,
          { ...Markup.inlineKeyboard([
              [Markup.button.callback('🚨 YES, SELL ALL', 'sell_all_execute')],
              [Markup.button.callback('❌ Cancel', 'main_menu')]
          ]), parse_mode: 'Markdown' }
        );
        break;
      }

      case 'sell_all_execute': {
        console.log("💰 Sell-all execution started.");
        try {
          const results = session.mevProtection
            ? await sellTokenMEVProtected(session.mint, 100)
            : await sellTokenSingle(session.mint, 100);

          console.log("✅ Sell-all completed. Results:", results);

          if (Array.isArray(results)) {
            const txLinks = results.map((tx, i) => `[Tx${i + 1}](https://solscan.io/tx/${tx})`).join(' ');
            await ctx.reply(
              '✅ **All Tokens Sold!**\n\n' + `📊 Transactions: ${txLinks}`,
              { ...getMainMenu(), parse_mode: 'Markdown' }
            );
          } else {
            await ctx.reply(
              '✅ **All Tokens Sold!**\n\n' +
              `📊 [View Transaction](https://solscan.io/tx/${results})`,
              { ...getMainMenu(), parse_mode: 'Markdown' }
            );
          }
        } catch (err) {
          console.error("❌ Sell-all failed:", err);
          await ctx.reply(
            `❌ **Sell Failed:**\n\n${err.message}`,
            { ...getMainMenu(), parse_mode: 'Markdown' }
          );
        }
        break;
      }

      default:
        console.warn(`⚠️ Unknown button action: ${action}`);
        break;
    }
  } catch (err) {
    console.error(`💥 Error handling button ${action}:`, err);
    try {
      await ctx.reply(`❌ Error: ${err.message}`, getMainMenu());
    } catch (e) {
      console.error("Failed to reply on error:", e);
    }
  }

  ctx.answerCbQuery();
});


// === ADVANCED BUTTON HANDLERS ===
// === ADVANCED BUTTON HANDLERS ===
bot.action('toggle_mev', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  session.mevProtection = !session.mevProtection;

  console.log(`🛡️ MEV Protection toggled: ${session.mevProtection ? 'ENABLED' : 'DISABLED'}`);

  ctx.reply(
    `🛡️ **MEV Protection ${session.mevProtection ? 'ENABLED' : 'DISABLED'}**\n\n` +
    `${session.mevProtection
      ? '✅ Transactions will use Jito private mempool\n✅ Transaction chunking active\n✅ Anti-sandwich protection'
      : '⚠️ Transactions will use public mempool\n⚠️ Vulnerable to MEV attacks'
    }`,
    { ...getAdvancedMenu(), parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

bot.action('toggle_multiwallet', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const availableWallets = multiWallet?.getActiveWallets?.() || [];
  console.log(`🎭 Multi-Wallet toggle requested. Available wallets: ${availableWallets.length}`);

  if (availableWallets.length < 2) {
    console.warn('⚠️ Multi-wallet toggle failed: Less than 2 wallets available.');
    ctx.answerCbQuery('Need multiple wallets! Add WALLET_PRIVATE_KEYS to environment.');
    return;
  }

  session.multiWallet = !session.multiWallet;
  console.log(`🎭 Multi-Wallet mode is now: ${session.multiWallet ? 'ENABLED' : 'DISABLED'}`);

  ctx.reply(
    `🎭 **Multi-Wallet ${session.multiWallet ? 'ENABLED' : 'DISABLED'}**\n\n` +
    `${session.multiWallet
      ? `✅ Using ${availableWallets.length} wallets for coordination\n✅ Natural trading patterns\n✅ Distributed risk`
      : '⚠️ Using single wallet only'
    }`,
    { ...getAdvancedMenu(), parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

bot.action('analyze_mev', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  if (!session.mint || typeof session.mint !== 'string') {
    console.warn('❌ analyze_mev: Invalid or missing token mint in session.');
    ctx.answerCbQuery('Set token first!');
    return;
  }

  console.log(`🔍 Starting MEV analysis for mint: ${session.mint}`);

  ctx.reply('🔍 **Analyzing MEV Activity...**', { parse_mode: 'Markdown' });

  try {
    const analysis = await mevProtection.detectMEVActivity(session.mint);
    console.log('📊 MEV Analysis Results:', analysis);

    if (!analysis || typeof analysis.riskScore !== 'number') {
      throw new Error('Invalid analysis result');
    }

    const analysisMsg = [
      '🔍 **MEV Analysis Results:**',
      '',
      `🎯 **Token:** ${session.mint.slice(0, 8)}...`,
      `📊 **Risk Score:** ${analysis.riskScore.toFixed(2)}/1.0`,
      `🛡️ **Recommended Protection:** ${analysis.recommendation?.toUpperCase?.() || 'UNKNOWN'}`,
      '',
      '📈 **Detected Activity:**',
      `🏃 Front-runs: ${analysis.indicators?.frontRuns ?? 0}`,
      `🥪 Sandwich attacks: ${analysis.indicators?.sandwiches ?? 0}`,
      `📋 Copy trades: ${analysis.indicators?.copyTrades ?? 0}`,
      `📊 Total transactions analyzed: ${analysis.indicators?.totalTxs ?? 0}`,
      '',
      `💡 **Recommendation:** ${
        analysis.riskScore > 0.7
          ? 'HIGH MEV RISK - Use maximum protection!'
          : analysis.riskScore > 0.3
            ? 'Medium risk - Standard protection recommended'
            : 'Low risk - Minimal protection needed'
      }`
    ].join('\n');

    ctx.reply(analysisMsg, { ...getAdvancedMenu(), parse_mode: 'Markdown' });
  } catch (err) {
    console.error('❌ MEV Analysis Failed:', err);
    ctx.reply(
      `❌ **MEV Analysis Failed:** ${err.message}`,
      { ...getAdvancedMenu(), parse_mode: 'Markdown' }
    );
  }

  ctx.answerCbQuery();
});

bot.action('multiwallet_status', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const wallets = multiWallet?.getActiveWallets?.() || [];
  console.log(`📊 Checking multi-wallet status: ${wallets.length} wallets found`);

  if (wallets.length === 0) {
    ctx.reply(
      '❌ **No wallets available!**\n\nCheck your WALLET_PRIVATE_KEYS environment variable.',
      { ...getAdvancedMenu(), parse_mode: 'Markdown' }
    );
    return;
  }

  const statusMsg = [
    '🎭 **Multi-Wallet Status:**',
    '',
    `👥 **Total Wallets:** ${wallets.length}`,
    `🎯 **Active Wallets:** ${wallets.filter(w => w.active).length}`,
    '',
    '💼 **Wallet Details:**'
  ];

  wallets.forEach((wallet, index) => {
    try {
      const pubKey = wallet.keypair?.publicKey?.toString?.();
      if (!pubKey) throw new Error('Missing public key');

      statusMsg.push(
        `${index + 1}. **${wallet.role?.toUpperCase?.() || 'UNKNOWN'}**`,
        `   📍 ${pubKey.slice(0, 8)}...${pubKey.slice(-4)}`,
        `   🔄 Status: ${wallet.active ? '🟢 Active' : '🔴 Inactive'}`,
        ''
      );
    } catch (err) {
      console.warn(`⚠️ Skipping wallet ${index + 1}:`, err.message);
    }
  });

  statusMsg.push(
    '💡 **Multi-Wallet Benefits:**',
    '• Natural trading patterns',
    '• Distributed risk across wallets',
    '• Harder to detect as coordinated',
    '• Better volume distribution'
  );

  ctx.reply(statusMsg.join('\n'), { ...getAdvancedMenu(), parse_mode: 'Markdown' });
  ctx.answerCbQuery();
});
    
              
        
       

// Handle unrecognized commands
// === MESSAGE HANDLER ===
bot.on('message', ctx => {
  if (!ctx?.from?.id) {
    console.warn('⚠️ Received message without valid ctx.from.id:', ctx.message);
    return;
  }

  if (ctx.from.id.toString() !== ADMIN) {
    console.log(`❌ Unauthorized user tried to interact: ${ctx.from.id}`);
    return;
  }

  const userId = ctx.from.id;
  const currentStep = getCurrentStep(userId);

  console.log(`📩 Message from ${userId}: "${ctx.message.text}" | Step: ${currentStep || 'none'}`);

  if (!currentStep && ctx.message.text && !ctx.message.text.startsWith('/')) {
    ctx.reply(
      '🤖 **Use the menu buttons below or send `/help` for available commands.**',
      getMainMenu()
    );
  }
});

// === ERROR HANDLING ===
bot.catch((err, ctx) => {
  console.error('❌ Bot error caught:', err);

  if (err.code === 409 || err.response?.error_code === 409) {
    console.log('❌ Bot conflict detected: Another instance is already running.');
    console.log('⚠️ Initiating graceful shutdown...');
    gracefulShutdown();
    return;
  }

  if (err.response?.error_code === 429) {
    console.log('⚠️ Rate limited by Telegram. Slowing down...');
    return;
  }

  if (ctx) {
    try {
      ctx.reply(
        `❌ **Bot Error:** ${err.message || 'Unknown error'}\n\nUse the menu below to continue.`,
        { ...getMainMenu(), parse_mode: 'Markdown' }
      );
    } catch (replyErr) {
      console.error('⚠️ Failed to send error message to user:', replyErr);
    }
  }
});

// === HEALTH CHECK SERVER FOR RENDER ===
const port = process.env.PORT || 3000;
const server = createServer((req, res) => {
  if (res.headersSent) {
    console.warn('⚠️ Response already sent for request:', req.url);
    return;
  }

  try {
    if (req.url === '/webhook' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        if (res.headersSent) return;
        try {
          const update = JSON.parse(body);
          console.log('📩 Webhook update received:', JSON.stringify(update, null, 2));
          bot.handleUpdate(update);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
        } catch (err) {
          console.error('❌ Webhook processing error:', err);
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Bad Request');
          }
        }
      });
    } else if (req.url === '/health' || req.url === '/') {
      const healthPayload = {
        status: 'healthy',
        bot_running: !isShuttingDown,
        pump_active: running,
        configured: !!session.mint,
        mev_protection: session.mevProtection,
        multi_wallet: session.multiWallet,
        wallet_count: multiWallet?.getActiveWallets?.().length || 0,
        timestamp: new Date().toISOString()
      };

      console.log('🌐 Health check ping received. Status:', healthPayload);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(healthPayload));
    } else {
      console.warn(`⚠️ Unknown request: ${req.method} ${req.url}`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  } catch (err) {
    console.error('❌ Server error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }
});

server.listen(port, () => {
  console.log(`🌐 Health check server running on port ${port}`);
});

// === GRACEFUL SHUTDOWN ===
// === GRACEFUL SHUTDOWN ===
async function gracefulShutdown(signal = 'manual') {
  if (isShuttingDown) {
    console.log(`[${new Date().toISOString()}] ⚠️ Shutdown already in progress (signal: ${signal})`);
    return;
  }

  isShuttingDown = true;
  running = false;

  console.log(`[${new Date().toISOString()}] 🔄 Initiating graceful shutdown... (signal: ${signal})`);

  try {
    await bot.telegram.sendMessage(ADMIN, `🛑 Bot shutting down... (signal: ${signal})`);
    console.log(`[${new Date().toISOString()}] 📩 Shutdown notice sent to admin`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Failed to send shutdown message:`, err);
  }

  try {
    await bot.stop();
    console.log(`[${new Date().toISOString()}] ✅ Bot stopped successfully`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Error during bot shutdown:`, err);
  }

  setTimeout(() => {
    console.log(`[${new Date().toISOString()}] 👋 Process exiting now`);
    process.exit(0);
  }, 2000);
}

// --- LAUNCH & SHUTDOWN ---
async function startBot() {
  try {
    const useWebhooks = process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL;
    console.log(`[${new Date().toISOString()}] 🚀 Starting bot (mode: ${useWebhooks ? 'webhook' : 'polling'})`);

    if (useWebhooks) {
      const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
      await bot.telegram.setWebhook(webhookUrl);
      console.log(`[${new Date().toISOString()}] 🔗 Webhook set to: ${webhookUrl}`);
    } else {
      await bot.launch({
        dropPendingUpdates: true,
        allowedUpdates: ['message', 'callback_query']
      });
      console.log(`[${new Date().toISOString()}] 🔄 Using polling mode`);
    }

    console.log(`[${new Date().toISOString()}] ✅ Net-Buy-Pumpet bot running!`);
    console.log(`[${new Date().toISOString()}] 🎭 Multi-wallet system: ${multiWallet.getActiveWallets().length} wallets loaded`);

    try {
      await bot.telegram.sendMessage(
        ADMIN,
        '🤖 **Net-Buy-Pumpet deployed and running!**\n\n' +
        `🛡️ MEV Protection: Ready\n` +
        `🎭 Multi-Wallet: ${multiWallet.getActiveWallets().length} wallets\n\n` +
        `Send /start to begin!`,
        { parse_mode: 'Markdown' }
      );
      console.log(`[${new Date().toISOString()}] 📩 Startup message sent to admin`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ❌ Failed to send startup message:`, err);
    }

  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Failed to start bot:`, err);

    if (err.code === 409 || err.response?.error_code === 409) {
      console.log(`[${new Date().toISOString()}] 💡 Another bot instance is already running.`);
      console.log('Solutions:');
      console.log('1. Stop any other running instances');
      console.log('2. Wait 60 seconds and try again');
      console.log('3. Use webhooks instead of polling for production');
    }

    process.exit(1);
  }
}

// === SIGNAL HANDLERS WITH LOGS ===
process.once('SIGINT', () => {
  console.log(`[${new Date().toISOString()}] 📨 Received SIGINT signal`);
  gracefulShutdown('SIGINT');
});

process.once('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] 📨 Received SIGTERM signal`);
  gracefulShutdown('SIGTERM');
});

process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] 💥 Uncaught Exception:`, err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] 💥 Unhandled Rejection at:`, promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// === START BOT ===
startBot();


    

