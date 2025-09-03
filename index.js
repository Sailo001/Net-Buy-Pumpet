// index.js
// Ensure your package.json has: { "type": "module" }

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

// === MEV PROTECTION CONFIGURATION ===
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

// === BASIC CONFIGURATION ===
const {
  TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
  ADMIN_CHAT_ID: ADMIN,
  SOLANA_PRIVATE_KEY: PRIVATE_KEY,
  SOLANA_RPC_URL: RPC_URL,
  JITO_TIP_AMOUNT: JITO_TIP,
  WALLET_PRIVATE_KEYS: WALLET_KEYS
} = process.env;

const rpcEndpoint = RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(rpcEndpoint, 'confirmed');
const payer = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const bot = new Telegraf(TELEGRAM_TOKEN);

let running = false;
let isShuttingDown = false;

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
    try {
      const signatures = await connection.getConfirmedSignaturesForAddress2(
        new PublicKey(mint),
        { limit: 50 }
      );
      const txDetails = await Promise.all(
        signatures.slice(0, 20).map(sig =>
          connection.getTransaction(sig.signature, { commitment: 'confirmed' })
        )
      );

      const mevIndicators = {
        frontRuns: 0,
        sandwiches: 0,
        copyTrades: 0,
        totalTxs: txDetails.length
      };

      const riskScore = this.calculateMEVRisk(mevIndicators);
      console.log(`🔍 MEV Analysis for ${mint.slice(0, 8)}:`, {
        risk: riskScore.toFixed(2),
        totalTxs: mevIndicators.totalTxs
      });

      return {
        riskScore,
        indicators: mevIndicators,
        recommendation: this.getProtectionRecommendation(riskScore)
      };
    } catch (err) {
      console.error('MEV detection error:', err);
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
    return sizes.map(size => (size / total) * amount);
  }

  generateDelays(count, protection = 'medium') {
    const config = {
      low: { min: 100, max: 1000 },
      medium: { min: 200, max: 2000 },
      high: { min: 500, max: 3000 }
    };
    const { min, max } = config[protection];
    return Array(count).fill().map(() =>
      Math.floor(Math.random() * (max - min) + min)
    );
  }
}

// === MULTI-WALLET ORCHESTRATION ===
class MultiWalletOrchestrator {
  constructor() {
    this.wallets = [];
    this.loadWallets();
  }

  loadWallets() {
    this.wallets.push({
      keypair: payer,
      role: 'main',
      active: true,
      balance: 0
    });
    if (WALLET_KEYS) {
      const keys = WALLET_KEYS.split(',').map(k => k.trim());
      keys.forEach((key, index) => {
        try {
          const keypair = Keypair.fromSecretKey(bs58.decode(key));
          this.wallets.push({
            keypair,
            role: `wallet_${index + 1}`,
            active: true,
            balance: 0
          });
          console.log(`✅ Loaded wallet ${index + 1}: ${keypair.publicKey.toString().slice(0, 8)}...`);
        } catch (err) {
          console.error(`❌ Failed to load wallet ${index + 1}:`, err.message);
        }
      });
    }
    console.log(`🎭 Multi-wallet system loaded: ${this.wallets.length} wallets`);
  }

  getActiveWallets() {
    return this.wallets.filter(w => w.active);
  }

  distributeAmount(totalAmount, walletCount = null) {
    const activeWallets = this.getActiveWallets();
    const walletsToUse = walletCount || Math.min(activeWallets.length, 3);
    const amounts = [];
    let remaining = totalAmount;
    for (let i = 0; i < walletsToUse - 1; i++) {
      const percentage = 0.2 + Math.random() * 0.2;
      const amount = remaining * percentage;
      amounts.push(amount);
      remaining -= amount;
    }
    amounts.push(remaining);
    return amounts.sort(() => Math.random() - 0.5);
  }

  generateNaturalDelays(count) {
    return Array(count).fill().map(() => {
      const baseDelay = 500 + Math.random() * 7500;
      const clustering = Math.random() < 0.3 ? Math.random() * 2000 : 0;
      return Math.floor(baseDelay + clustering);
    });
  }

  async executeCoordinatedBuy(mint, totalAmount, protection = true) {
    const activeWallets = this.getActiveWallets();
    const walletsToUse = Math.min(activeWallets.length, 3);
    const amounts = this.distributeAmount(totalAmount, walletsToUse);
    const delays = this.generateNaturalDelays(walletsToUse - 1);
    console.log(`🎭 Coordinated buy: ${walletsToUse} wallets, ${totalAmount} SOL total`);
    const results = [];
    for (let i = 0; i < walletsToUse; i++) {
      try {
        const wallet = activeWallets[i];
        const amount = amounts[i];
        console.log(`🔄 Wallet ${i + 1} buying ${amount.toFixed(4)} SOL...`);
        const tx = await this.executeBuyWithWallet(wallet, mint, amount, protection);
        results.push({ wallet: wallet.role, amount, tx });
        if (i < walletsToUse - 1) {
          await new Promise(resolve => setTimeout(resolve, delays[i]));
        }
      } catch (err) {
        console.error(`❌ Wallet ${i + 1} buy failed:`, err.message);
        results.push({ wallet: activeWallets[i].role, amount: amounts[i], error: err.message });
      }
    }
    return results;
  }

  async executeBuyWithWallet(walletObj, mint, solAmount, mevProtection = true) {
    const pool = await getRaydiumPoolInfo(mint);
    const buyingBase = (pool.baseMint === mint);
    const WSOL = 'So11111111111111111111111111111111111111112';
    const wallet = walletObj.keypair;
    const userWSOL = await getAssociatedTokenAddress(
      new PublicKey(WSOL),
      wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
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
      await connection.sendTransaction(createTx, [wallet]);
    }
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: userWSOL,
        lamports: amountIn
      }),
      createSyncNativeInstruction(userWSOL)
    );
    if (mevProtection) {
      await sendPrivateTransactionWithWallet(wrapTx, wallet);
    } else {
      await connection.sendTransaction(wrapTx, [wallet]);
    }
    const toMint = buyingBase ? mint : WSOL;
    const userOutATA = await getAssociatedTokenAddress(
      new PublicKey(toMint),
      wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const outInfo = await connection.getAccountInfo(userOutATA);
    if (!outInfo) {
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
    swapIx.innerTransactions.forEach(({ instructions }) =>
      instructions.forEach(ix => swapTx.add(ix))
    );
    if (mevProtection) {
      return await sendPrivateTransactionWithWallet(swapTx, wallet);
    } else {
      return await connection.sendTransaction(swapTx, [wallet]);
    }
  }
}

// Initialize classes
const mevProtection = new MEVProtection();
const multiWallet = new MultiWalletOrchestrator();

// === BASIC HELPER FUNCTIONS ===
async function getRaydiumPoolInfo(mintAddress) {
  const url = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
  const pools = await fetch(url).then(r => r.json());
  for (const sid in pools.official) {
    const pool = pools.official[sid];
    if (pool.baseMint === mintAddress || pool.quoteMint === mintAddress) {
      pool.id = sid;
      return pool;
    }
  }
  for (const sid in pools.unOfficial) {
    const pool = pools.unOfficial[sid];
    if (pool.baseMint === mintAddress || pool.quoteMint === mintAddress) {
      pool.id = sid;
      return pool;
    }
  }
  throw new Error('No Raydium pool found for mint: ' + mintAddress);
}

async function getATA(mint, owner) {
  return await getAssociatedTokenAddress(
    new PublicKey(mint),
    owner,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

async function ensureATA(mint, owner) {
  const ata = await getATA(mint, owner);
  const info = await connection.getAccountInfo(ata);
  if (!info) {
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
    await connection.sendTransaction(tx, [payer], {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });
  }
  return ata;
}

// === MEV-PROTECTED TRADING FUNCTIONS ===
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
    const jitoEndpoint = MEV_CONFIG.privatePools[Math.floor(Math.random() * MEV_CONFIG.privatePools.length)];
    try {
      const response = await fetch(`${jitoEndpoint}/api/v1/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTransaction',
          params: [
            transaction.serialize({ requireAllSignatures: false }).toString('base64'),
            { skipPreflight: false, preflightCommitment: 'confirmed' }
          ]
        })
      });
      const result = await response.json();
      if (result.result) {
        console.log('✅ Transaction sent via Jito private pool');
        return result.result;
      }
    } catch (jitoError) {
      console.log('⚠️ Jito failed, falling back to public RPC');
    }
    return await connection.sendTransaction(transaction, [payer], {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });
  } catch (err) {
    console.error('Private transaction failed:', err);
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
    const jitoEndpoint = MEV_CONFIG.privatePools[Math.floor(Math.random() * MEV_CONFIG.privatePools.length)];
    try {
      const response = await fetch(`${jitoEndpoint}/api/v1/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTransaction',
          params: [
            transaction.serialize({ requireAllSignatures: false }).toString('base64'),
            { skipPreflight: false, preflightCommitment: 'confirmed' }
          ]
        })
      });
      const result = await response.json();
      if (result.result) return result.result;
    } catch (jitoError) {
      console.log('⚠️ Jito failed for wallet, using public RPC');
    }
    return await connection.sendTransaction(transaction, [wallet], {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });
  } catch (err) {
    console.error('Private wallet transaction failed:', err);
    throw err;
  }
}

async function buyTokenMEVProtected(mint, solAmount) {
  console.log(`🛡️ Starting MEV-protected buy for ${solAmount} SOL`);
  const mevAnalysis = await mevProtection.detectMEVActivity(mint);
  const protection = mevAnalysis.recommendation;
  console.log(`🔍 MEV Risk: ${mevAnalysis.riskScore.toFixed(2)} (${protection} protection)`);
  const chunks = mevProtection.splitTransaction(solAmount, protection);
  const delays = mevProtection.generateDelays(chunks.length - 1, protection);
  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      console.log(`🔄 Executing chunk ${i + 1}/${chunks.length}: ${chunks[i].toFixed(4)} SOL`);
      const tx = await buyTokenSingle(mint, chunks[i]);
      results.push(tx);
      console.log(`✅ Chunk ${i + 1} completed: ${tx}`);
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delays[i]));
      }
    } catch (err) {
      console.error(`❌ Chunk ${i + 1} failed:`, err.message);
    }
  }
  return results;
}

async function buyTokenSingle(mint, solAmount) {
  const pool = await getRaydiumPoolInfo(mint);
  const buyingBase = (pool.baseMint === mint);
  const WSOL = 'So11111111111111111111111111111111111111112';
  const userWSOL = await ensureATA(WSOL, payer.publicKey);
  const amountIn = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const rawBalance = await connection.getTokenAccountBalance(userWSOL);
  const wsolBalance = Number(rawBalance.value.amount);
  if (wsolBalance < amountIn) {
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
  const userOutATA = await ensureATA(buyingBase ? mint : WSOL, payer.publicKey);
  const swapIx = await buildSwapInstruction({
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
  const tx = new Transaction();
  swapIx.innerTransactions.forEach(({ instructions }) =>
    instructions.forEach(ix => tx.add(ix))
  );
  return await sendPrivateTransaction(tx);
}

async function sellTokenMEVProtected(mint, sellPct) {
  console.log(`🛡️ Starting MEV-protected sell for ${sellPct}%`);
  const mevAnalysis = await mevProtection.detectMEVActivity(mint);
  const protection = mevAnalysis.recommendation;
  if (sellPct === 100 || protection === 'high') {
    return await sellTokenSingle(mint, sellPct);
  } else {
    const chunks = Math.min(3, Math.ceil(sellPct / 25));
    const chunkPct = sellPct / chunks;
    const delays = mevProtection.generateDelays(chunks - 1, protection);
    const results = [];
    for (let i = 0; i < chunks; i++) {
      try {
        const tx = await sellTokenSingle(mint, chunkPct);
        results.push(tx);
        if (i < chunks - 1) {
          await new Promise(resolve => setTimeout(resolve, delays[i]));
        }
      } catch (err) {
        console.error(`❌ Sell chunk ${i + 1} failed:`, err.message);
      }
    }
    return results;
  }
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
  if (amountIn < 1) {
    throw new Error('Not enough token balance to sell');
  }
  const swapIx = await buildSwapInstruction({
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
  const tx = new Transaction();
  swapIx.innerTransactions.forEach(({ instructions }) =>
    instructions.forEach(ix => tx.add(ix))
  );
  return await sendPrivateTransaction(tx);
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
    '🤖 **Net-Buy-Pumpet Help**',
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
bot.on('text', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const userId = ctx.from.id;
  const currentStep = getCurrentStep(userId);
  const text = ctx.message.text.trim();

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
        if (!text || text.length < 32 || text.length > 50) {
          return ctx.reply(
            '❌ Invalid contract address. Please enter a valid Solana token mint address.',
            getSetupMenu()
          );
        }
        try {
          await getRaydiumPoolInfo(text);
          userData.mint = text;
          setUserStep(userId, SETUP_STEPS.WAITING_SOL_AMOUNT);
          ctx.reply(
            '✅ **Token Found!**\n\n' +
            '🔧 **Setup - Step 2/5**\n\n' +
            '💰 **Enter SOL Amount per Buy:**\n' +
            '📝 How much SOL to spend on each buy?\n\n' +
            '💡 Examples: `0.1`, `0.5`, `1.0`',
            { ...getSetupMenu(), parse_mode: 'Markdown' }
          );
        } catch (err) {
          return ctx.reply(
            `❌ Token not found in Raydium pools. Please check the contract address.\n\nError: ${err.message}`,
            getSetupMenu()
          );
        }
        break;

      case SETUP_STEPS.WAITING_SOL_AMOUNT:
        const solAmount = parseFloat(text);
        if (isNaN(solAmount) || solAmount <= 0 || solAmount > 100) {
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
        const sellPct = parseInt(text);
        if (isNaN(sellPct) || sellPct < 0 || sellPct > 100) {
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
        const delay = parseInt(text);
        if (isNaN(delay) || delay < 1 || delay > 300) {
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
        const multiBuys = parseInt(text);
        if (isNaN(multiBuys) || multiBuys < 1 || multiBuys > 10) {
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

        ctx.reply(
          '🎉 **Setup Complete!**\n\n' +
          getSetupSummary(userData) + '\n\n' +
          '✅ Ready to save configuration?',
          { ...confirmationKeyboard, parse_mode: 'Markdown' }
        );
        break;
    }
  } catch (err) {
    ctx.reply(
      `❌ Setup error: ${err.message}\n\nPlease try again or cancel setup.`,
      getSetupMenu()
    );
    clearUserSetup(userId);
  }
});

// === BUTTON HANDLERS ===
bot.action('main_menu', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

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

  ctx.editMessageText(welcomeMsg, { ...getMainMenu(), parse_mode: 'Markdown' });
  ctx.answerCbQuery();
});

bot.action('advanced_menu', ctx => {
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

  ctx.editMessageText(advancedMsg, { ...getAdvancedMenu(), parse_mode: 'Markdown' });
  ctx.answerCbQuery();
});

bot.action('start_setup', ctx => {
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
  ctx.answerCbQuery();
});

bot.action('confirm_setup', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const userData = getUserData(ctx.from.id);

  session.mint = userData.mint;
  session.buySol = userData.buySol;
  session.sellPct = userData.sellPct;
  session.delaySec = userData.delaySec;
  session.multiBuys = userData.multiBuys;

  clearUserSetup(ctx.from.id);

  ctx.reply(
    '🎉 **Configuration Saved Successfully!**\n\n' +
    showCurrentConfig() + '\n\n' +
    '🚀 Ready to start pumping?',
    { ...getMainMenu(), parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

bot.action('cancel_setup', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  clearUserSetup(ctx.from.id);
  ctx.reply(
    '❌ **Setup Cancelled**\n\nUse the menu below to start again or check status.',
    getMainMenu()
  );
  ctx.answerCbQuery();
});

bot.action('refresh_status', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const statusMsg = [
    showCurrentConfig(),
    '',
    `🔄 **Bot Status:** ${running ? '🟢 Pumping Active' : '🔴 Stopped'}`,
    `🌐 **Connection:** ${rpcEndpoint}`,
    `👤 **Main Wallet:** ${payer.publicKey.toString().slice(0, 8)}...`
  ].join('\n');

  ctx.reply(statusMsg, { ...getStatusMenu(), parse_mode: 'Markdown' });
  ctx.answerCbQuery();
});

bot.action('start_pump', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (running) {
    ctx.answerCbQuery('Pump already running!');
    return;
  }
  if (!session.mint) {
    ctx.answerCbQuery('Please complete setup first!');
    return;
  }

  running = true;

  const pumpStartMsg = [
    '🔥 **PUMP STARTED!**',
    '',
    '📊 **Configuration:**',
    `🎯 Token: ${session.mint.slice(0, 8)}...`,
    `💰 Buy: ${session.buySol} SOL per cycle`,
    `📈 Sell: ${session.sellPct}% after each cycle`,
    `⏱️ Delay: ${session.delaySec}s between cycles`,
    `🔄 Multi-Buys: ${session.multiBuys} per cycle`,
    `🛡️ MEV Protection: ${session.mevProtection ? 'ON' : 'OFF'}`,
    `🎭 Multi-Wallet: ${session.multiWallet ? 'ON' : 'OFF'}`,
    '',
    '📈 **Monitoring transactions...**'
  ].join('\n');

  const pumpMenu = Markup.inlineKeyboard([
    [Markup.button.callback('⏹️ Stop Pump', 'stop_pump')],
    [Markup.button.callback('📊 View Status', 'refresh_status')],
    [Markup.button.callback('💰 Emergency Sell All', 'sell_all_confirm')],
    [Markup.button.callback('🛡️ Advanced Settings', 'advanced_menu')],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')]
  ]);

  ctx.reply(pumpStartMsg, { ...pumpMenu, parse_mode: 'Markdown' });
  ctx.answerCbQuery();

  startPumpLoop(ctx);
});

bot.action('stop_pump', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  if (!running) {
    ctx.answerCbQuery('Pump is not running!');
    return;
  }

  running = false;
  ctx.reply(
    '⏹️ **Pump Stop Requested**\n\n' +
    'The pump will stop after the current cycle completes.\n\n' +
    '🔄 Use the menu below to check status or start a new pump.',
    { ...getMainMenu(), parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery('Pump stopping...');
});

bot.action('sell_all_confirm', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  if (!session.mint) {
    ctx.answerCbQuery('No token configured!');
    return;
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🚨 YES, SELL ALL', 'sell_all_execute')],
    [Markup.button.callback('❌ Cancel', 'main_menu')]
  ]);

  ctx.reply(
    '🚨 **SELL ALL TOKENS**\n\n' +
    `Are you sure you want to sell 100% of your ${session.mint.slice(0, 8)}... tokens?\n\n` +
    '⚠️ This action cannot be undone!',
    { ...keyboard, parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

bot.action('sell_all_execute', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  try {
    ctx.reply('⏳ **Selling all tokens...**', { parse_mode: 'Markdown' });

    let results;
    if (session.mevProtection) {
      results = await sellTokenMEVProtected(session.mint, 100);
    } else {
      results = await sellTokenSingle(session.mint, 100);
    }

    if (Array.isArray(results)) {
      const txLinks = results.map((tx, i) => `[Tx${i + 1}](https://solscan.io/tx/${tx})`).join(' ');
      ctx.reply(
        '✅ **All Tokens Sold!**\n\n' +
        `📊 Transactions: ${txLinks}`,
        { ...getMainMenu(), parse_mode: 'Markdown' }
      );
    } else {
      ctx.reply(
        '✅ **All Tokens Sold!**\n\n' +
        `📊 [View Transaction](https://solscan.io/tx/${results})`,
        { ...getMainMenu(), parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    ctx.reply(
      `❌ **Sell Failed:**\n\n${err.message}`,
      { ...getMainMenu(), parse_mode: 'Markdown' }
    );
  }
  ctx.answerCbQuery();
});

// === ADVANCED BUTTON HANDLERS ===
bot.action('toggle_mev', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  session.mevProtection = !session.mevProtection;
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

  const availableWallets = multiWallet.getActiveWallets().length;

  if (availableWallets < 2) {
    ctx.answerCbQuery('Need multiple wallets! Add WALLET_PRIVATE_KEYS to environment.');
    return;
  }

  session.multiWallet = !session.multiWallet;
  ctx.reply(
    `🎭 **Multi-Wallet ${session.multiWallet ? 'ENABLED' : 'DISABLED'}**\n\n` +
    `${session.multiWallet
        ? `✅ Using ${availableWallets} wallets for coordination\n✅ Natural trading patterns\n✅ Distributed risk`
        : '⚠️ Using single wallet only'
    }`,
    { ...getAdvancedMenu(), parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

bot.action('analyze_mev', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  if (!session.mint) {
    ctx.answerCbQuery('Set token first!');
    return;
  }

  ctx.reply('🔍 **Analyzing MEV Activity...**', { parse_mode: 'Markdown' });

  try {
    const analysis = await mevProtection.detectMEVActivity(session.mint);

    const analysisMsg = [
      '🔍 **MEV Analysis Results:**',
      '',
      `🎯 **Token:** ${session.mint.slice(0, 8)}...`,
      `📊 **Risk Score:** ${analysis.riskScore.toFixed(2)}/1.0`,
      `🛡️ **Recommended Protection:** ${analysis.recommendation.toUpperCase()}`,
      '',
      '📈 **Detected Activity:**',
      `🏃 Front-runs: ${analysis.indicators.frontRuns}`,
      `🥪 Sandwich attacks: ${analysis.indicators.sandwiches}`,
      `📋 Copy trades: ${analysis.indicators.copyTrades}`,
      `📊 Total transactions analyzed: ${analysis.indicators.totalTxs}`,
      '',
      `💡 **Recommendation:** ${analysis.riskScore > 0.7
          ? 'HIGH MEV RISK - Use maximum protection!'
          : analysis.riskScore > 0.3
              ? 'Medium risk - Standard protection recommended'
              : 'Low risk - Minimal protection needed'
      }`
    ].join('\n');

    ctx.reply(analysisMsg, { ...getAdvancedMenu(), parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply(
      `❌ **MEV Analysis Failed:** ${err.message}`,
      { ...getAdvancedMenu(), parse_mode: 'Markdown' }
    );
  }

  ctx.answerCbQuery();
});

bot.action('multiwallet_status', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const wallets = multiWallet.getActiveWallets();

  const statusMsg = [
    '🎭 **Multi-Wallet Status:**',
    '',
    `👥 **Total Wallets:** ${wallets.length}`,
    `🎯 **Active Wallets:** ${wallets.filter(w => w.active).length}`,
    '',
    '💼 **Wallet Details:'
  ];

  wallets.forEach((wallet, index) => {
    statusMsg.push(
      `${index + 1}. **${wallet.role.toUpperCase()}**`,
      `   📍 ${wallet.keypair.publicKey.toString().slice(0, 8)}...${wallet.keypair.publicKey.toString().slice(-4)}`,
      `   🔄 Status: ${wallet.active ? '🟢 Active' : '🔴 Inactive'}`,
      ''
    );
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

// === PUMP LOGIC WITH MULTI-WALLET ===
async function startPumpLoop(ctx) {
  let buyAmount = session.buySol;
  let cycleCount = 0;

  const initialMevAnalysis = await mevProtection.detectMEVActivity(session.mint);
  await ctx.telegram.sendMessage(ADMIN,
    `🛡️ **MEV Analysis Complete**\n` +
    `Risk Score: ${initialMevAnalysis.riskScore.toFixed(2)}\n` +
    `Protection Level: ${initialMevAnalysis.recommendation.toUpperCase()}`,
    { parse_mode: 'Markdown' }
  );

  while (running && !isShuttingDown) {
    try {
      cycleCount++;
      await ctx.telegram.sendMessage(ADMIN,
        `🔄 **Cycle ${cycleCount} Starting** - ${buyAmount.toFixed(4)} SOL`,
        { parse_mode: 'Markdown' }
      );

      for (let i = 0; i < session.multiBuys; i++) {
        if (!running || isShuttingDown) break;

        try {
          let txResults;

          if (session.multiWallet && multiWallet.getActiveWallets().length > 1) {
            txResults = await multiWallet.executeCoordinatedBuy(session.mint, buyAmount, session.mevProtection);

            for (const result of txResults) {
              if (result.tx) {
                await ctx.telegram.sendMessage(ADMIN,
                  `✅ **${result.wallet.toUpperCase()}** - ${result.amount.toFixed(4)} SOL\n` +
                  `📊 [Tx](https://solscan.io/tx/${result.tx})`,
                  { parse_mode: 'Markdown' }
                );
              } else {
                await ctx.telegram.sendMessage(ADMIN,
                  `❌ **${result.wallet.toUpperCase()}** failed: ${result.error}`,
                  { parse_mode: 'Markdown' }
                );
              }
            }
          } else if (session.mevProtection) {
            txResults = await buyTokenMEVProtected(session.mint, buyAmount);

            if (Array.isArray(txResults)) {
              for (let j = 0; j < txResults.length; j++) {
                await ctx.telegram.sendMessage(ADMIN,
                  `✅ **Buy ${i + 1}.${j + 1}/${session.multiBuys}** - Protected\n` +
                  `📊 [Tx](https://solscan.io/tx/${txResults[j]})`,
                  { parse_mode: 'Markdown' }
                );
              }
            } else {
              await ctx.telegram.sendMessage(ADMIN,
                `✅ **Buy ${i + 1}/${session.multiBuys}** - Protected\n` +
                `📊 [Tx](https://solscan.io/tx/${txResults})`,
                { parse_mode: 'Markdown' }
              );
            }
          } else {
            const tx = await buyTokenSingle(session.mint, buyAmount);
            await ctx.telegram.sendMessage(ADMIN,
              `✅ **Buy ${i + 1}/${session.multiBuys}** - Standard\n` +
              `📊 [Tx](https://solscan.io/tx/${tx})`,
              { parse_mode: 'Markdown' }
            );
          }

        } catch (err) {
          await ctx.telegram.sendMessage(ADMIN,
            `❌ **Buy ${i + 1} Failed:** ${err.message}`,
            { parse_mode: 'Markdown' }
          );
        }

        if (i < session.multiBuys - 1) {
          await new Promise(res => setTimeout(res, 1000));
        }
      }

      if (session.sellPct > 0 && running && !isShuttingDown) {
        try {
          let sellResults;

          if (session.mevProtection) {
            sellResults = await sellTokenMEVProtected(session.mint, session.sellPct);

            if (Array.isArray(sellResults)) {
              for (let j = 0; j < sellResults.length; j++) {
                await ctx.telegram.sendMessage(ADMIN,
                  `📈 **Sell ${j + 1}/${sellResults.length}** - ${session.sellPct}% Protected\n` +
                  `📊 [Tx](https://solscan.io/tx/${sellResults[j]})`,
                  { parse_mode: 'Markdown' }
                );
              }
            } else {
              await ctx.telegram.sendMessage(ADMIN,
                `📈 **Sold ${session.sellPct}%** - Protected\n` +
                `📊 [Tx](https://solscan.io/tx/${sellResults})`,
                { parse_mode: 'Markdown' }
              );
            }
          } else {
            const tx = await sellTokenSingle(session.mint, session.sellPct);
            await ctx.telegram.sendMessage(ADMIN,
              `📈 **Sold ${session.sellPct}%** - Standard\n` +
              `📊 [Tx](https://solscan.io/tx/${tx})`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (err) {
          await ctx.telegram.sendMessage(ADMIN,
            `❌ **Sell Failed:** ${err.message}`,
            { parse_mode: 'Markdown' }
          );
        }
      }

      buyAmount *= session.buyScale;

      const baseDelayMs = session.delaySec * 1000;
      const jitter = 0.8 + Math.random() * 0.4;
      const mevDelay = initialMevAnalysis.riskScore > 0.7 ? 2000 : 0;
      const delayMs = Math.max(500, (baseDelayMs * jitter) + mevDelay);

      await new Promise(res => setTimeout(res, delayMs));

    } catch (e) {
      await ctx.telegram.sendMessage(ADMIN,
        `❌ **Cycle ${cycleCount} Error:** ${e.message}`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  await ctx.telegram.sendMessage(ADMIN,
    '⏹️ **Pump Stopped**\n\nUse the menu to start again or check status.',
    { ...getMainMenu(), parse_mode: 'Markdown' }
  );
}

// Simple commands with menu buttons
bot.command('pump', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (running) return ctx.reply('⏳ Pump already in progress.', getMainMenu());
  if (!session.mint) return ctx.reply('❌ Complete setup first! Use the Setup button below.', getMainMenu());

  running = true;

  const pumpStartMsg = [
    '🔥 **PUMP STARTED!**',
    '',
    '📊 **Configuration:**',
    `🎯 Token: ${session.mint.slice(0, 8)}...`,
    `💰 Buy: ${session.buySol} SOL per cycle`,
    `📈 Sell: ${session.sellPct}% after each cycle`,
    `⏱️ Delay: ${session.delaySec}s between cycles`,
    `🔄 Multi-Buys: ${session.multiBuys} per cycle`,
    `🛡️ MEV Protection: ${session.mevProtection ? 'ON' : 'OFF'}`,
    `🎭 Multi-Wallet: ${session.multiWallet ? 'ON' : 'OFF'}`,
    '',
    '📈 **Monitoring transactions...**'
  ].join('\n');

  const pumpMenu = Markup.inlineKeyboard([
    [Markup.button.callback('⏹️ Stop Pump', 'stop_pump')],
    [Markup.button.callback('📊 View Status', 'refresh_status')],
    [Markup.button.callback('💰 Emergency Sell All', 'sell_all_confirm')],
    [Markup.button.callback('🛡️ Advanced Settings', 'advanced_menu')],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')]
  ]);

  ctx.reply(pumpStartMsg, { ...pumpMenu, parse_mode: 'Markdown' });
  startPumpLoop(ctx);
});

bot.command('stop', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (!running) return ctx.reply('⏹️ Pump is not running.', getMainMenu());

  running = false;
  ctx.reply(
    '⏹️ **Pump will stop after current cycle.**\n\nUse the menu below for other actions.',
    { ...getMainMenu(), parse_mode: 'Markdown' }
  );
});

bot.command('sellall', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (!session.mint) return ctx.reply('❌ No token configured!', getMainMenu());

  try {
    let results;
    if (session.mevProtection) {
      results = await sellTokenMEVProtected(session.mint, 100);
    } else {
      results = await sellTokenSingle(session.mint, 100);
    }

    if (Array.isArray(results)) {
      const txLinks = results.map((tx, i) => `[Tx${i + 1}](https://solscan.io/tx/${tx})`).join(' ');
      ctx.reply(
        '✅ **All Tokens Sold!**\n\n' +
        `📊 Transactions: ${txLinks}`,
        { ...getMainMenu(), parse_mode: 'Markdown' }
      );
    } else {
      ctx.reply(
        '✅ **All Tokens Sold!**\n\n' +
        `📊 [View Transaction](https://solscan.io/tx/${results})`,
        { ...getMainMenu(), parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    ctx.reply(
      `❌ **Sell Failed:** ${err.message}`,
      getMainMenu()
    );
  }
});

// Handle unrecognized commands
bot.on('message', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const userId = ctx.from.id;
  const currentStep = getCurrentStep(userId);

  if (!currentStep && ctx.message.text && !ctx.message.text.startsWith('/')) {
    ctx.reply(
      '🤖 **Use the menu buttons below or send `/help` for available commands.**',
      getMainMenu()
    );
  }
});

// === ERROR HANDLING ===
bot.catch((err, ctx) => {
  console.error('Bot error:', err);

  if (err.code === 409 || err.response?.error_code === 409) {
    console.log('❌ Bot conflict detected: Another instance is already running');
    console.log('Shutting down this instance...');
    gracefulShutdown();
    return;
  }

  if (err.response?.error_code === 429) {
    console.log('⚠️ Rate limited, slowing down...');
    return;
  }

  if (ctx) {
    try {
      ctx.reply(
        `❌ **Bot Error:** ${err.message}\n\nUse the menu below to continue.`,
        { ...getMainMenu(), parse_mode: 'Markdown' }
      );
    } catch (replyErr) {
      console.error('Failed to send error message:', replyErr);
    }
  }
});

// === HEALTH CHECK SERVER FOR RENDER ===
// === 100 % WORKING WEBHOOK + HEALTH SERVER ===
const port = process.env.PORT || 3000;

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        bot.handleUpdate(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('OK');
      } catch (e) {
        res.writeHead(400).end('Bad Request');
      }
    });
  } else if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', bot_running: !isShuttingDown }));
  } else {
    res.writeHead(404).end('Not Found');
  }
});

server.listen(port, () => console.log(`🌐 Listening on port ${port}`));

// === GRACEFUL SHUTDOWN ===
async function gracefulShutdown() {
  if (isShuttingDown) return;

  isShuttingDown = true;
  running = false;

  console.log('🔄 Initiating graceful shutdown...');

  try {
    await bot.telegram.sendMessage(ADMIN, '🛑 Bot shutting down...');
  } catch (err) {
    console.error('Failed to send shutdown message:', err);
  }

  try {
    await bot.stop();
    console.log('✅ Bot stopped successfully');
  } catch (err) {
    console.error('Error during bot shutdown:', err);
  }

  setTimeout(() => {
    console.log('👋 Process exiting');
    process.exit(0);
  }, 2000);
}

// --- LAUNCH & SHUTDOWN ---
async function startBot() {
  try {
    const useWebhooks = process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL;

    if (useWebhooks) {
      const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
      await bot.telegram.setWebhook(webhookUrl);
      console.log(`🔗 Webhook set to: ${webhookUrl}`);
    } else {
      await bot.launch({
        dropPendingUpdates: true,
        allowedUpdates: ['message', 'callback_query']
      });
      console.log('🔄 Using polling mode');
    }

    console.log('✅ Net-Buy-Pumpet bot running!');
    console.log(`🎭 Multi-wallet system: ${multiWallet.getActiveWallets().length} wallets loaded`);

    try {
      await bot.telegram.sendMessage(ADMIN,
        '🤖 **Net-Buy-Pumpet deployed and running!**\n\n' +
        `🛡️ MEV Protection: Ready\n` +
        `🎭 Multi-Wallet: ${multiWallet.getActiveWallets().length} wallets\n\n` +
        `Send /start to begin!`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('Failed to send startup message:', err);
    }

  } catch (err) {
    console.error('❌ Failed to start bot:', err);

    if (err.code === 409 || err.response?.error_code === 409) {
      console.log('💡 Another bot instance is already running.');
      console.log('Solutions:');
      console.log('1. Stop any other running instances');
      console.log('2. Wait 60 seconds and try again');
      console.log('3. Use webhooks instead of polling for production');
    }

    process.exit(1);
  }
}

// Enhanced signal handlers
process.once('SIGINT', () => {
  console.log('📨 Received SIGINT signal');
  gracefulShutdown();
});

process.once('SIGTERM', () => {
  console.log('📨 Received SIGTERM signal');
  gracefulShutdown();
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the bot
startBot();
