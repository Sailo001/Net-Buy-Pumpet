// index.js
// Ensure package.json has:  { "type": "module" }

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

// ---------- MEV CONFIG ----------
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

// ---------- BASIC CONFIG ----------
const {
  TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
  ADMIN_CHAT_ID: ADMIN,
  SOLANA_PRIVATE_KEY: PRIVATE_KEY,
  SOLANA_RPC_URL: RPC_URL,
  JITO_TIP_AMOUNT: JITO_TIP,
  WALLET_PRIVATE_KEYS: WALLET_KEYS
} = process.env;

if (!PRIVATE_KEY) throw new Error('Missing SOLANA_PRIVATE_KEY');
if (!TELEGRAM_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');

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

// ---------- MEV PROTECTION ----------
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

// ---------- MULTI-WALLET ----------
class MultiWalletOrchestrator {
  constructor() {
    this.wallets = [];
    this.loadWallets();
  }

  loadWallets() {
    this.wallets.push({ keypair: payer, role: 'main', active: true, balance: 0 });
    if (WALLET_KEYS) {
      const keys = WALLET_KEYS.split(',').map(k => k.trim());
      keys.forEach((key, index) => {
        try {
          const keypair = Keypair.fromSecretKey(bs58.decode(key));
          this.wallets.push({ keypair, role: `wallet_${index + 1}`, active: true, balance: 0 });
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
        if (i < walletsToUse - 1) await new Promise(resolve => setTimeout(resolve, delays[i]));
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
    if (mevProtection) await sendPrivateTransactionWithWallet(wrapTx, wallet);
    else await connection.sendTransaction(wrapTx, [wallet]);

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
    return mevProtection
      ? await sendPrivateTransactionWithWallet(swapTx, wallet)
      : await connection.sendTransaction(swapTx, [wallet]);
  }
}

const mevProtection = new MEVProtection();
const multiWallet = new MultiWalletOrchestrator();

// ---------- HELPERS ----------
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
  return await getAssociatedTokenAddress(new PublicKey(mint), owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
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
    await connection.sendTransaction(tx, [payer], { skipPreflight: false, preflightCommitment: 'confirmed' });
  }
  return ata;
}

// ---------- TRADING ----------
async function sendPrivateTransaction(transaction, tip = 10000) {
  try {
    const tipAmount = parseInt(JITO_TIP) || tip;
    if (tipAmount > 0) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
          lamports: tipAmount
        })
      );
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
    } catch {
      console.log('⚠️ Jito failed, fallback to public RPC');
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
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
          lamports: tipAmount
        })
      );
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
    } catch {
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
  const mevAnalysis = await mevProtection.detectMEVActivity(mint);
  const protection = mevAnalysis.recommendation;
  const chunks = mevProtection.splitTransaction(solAmount, protection);
  const delays = mevProtection.generateDelays(chunks.length - 1, protection);
  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const tx = await buyTokenSingle(mint, chunks[i]);
      results.push(tx);
      if (i < chunks.length - 1) await new Promise(resolve => setTimeout(resolve, delays[i]));
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
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: userWSOL, lamports: amountIn }),
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
        if (i < chunks - 1) await new Promise(resolve => setTimeout(resolve, delays[i]));
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
  if (amountIn < 1) throw new Error('Not enough token balance to sell');
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

// ---------- MENU ----------
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

function getSetupMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel Setup', 'cancel_setup')],
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
  if (!setupFlow.data.has(userId)) setupFlow.data.set(userId, {});
  return setupFlow.data.get(userId);
}

function showCurrentConfig() {
  return [
    '📊 **Current Configuration:**',
    `🎯 **Token:** ${session.mint || 'Not set'}`,
    `💰 **Buy Amount:** ${session.buySol} SOL`,
    `📈 **Sell Percentage:** ${session.sellPct}%`,
    `⏱️ **Delay:** ${session.delaySec} seconds`,
    `🔄 **Multi-Buys:** ${session.multiBuys} per cycle`,
    `📈 **Buy Scaling:** ${session.buyScale}x`,
    `🛡️ MEV Protection: ${session.mevProtection ? '🟢 ON' : '🔴 OFF'}`,
    `🎭 Multi-Wallet: ${session.multiWallet ? '🟢 ON' : '🔴 OFF'}`,
    `🎭 Available Wallets: ${multiWallet.getActiveWallets().length}`
  ].join('\n');
}

// ---------- TELEGRAM HANDLERS ----------
bot.start(ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  ctx.reply(
    '🤖 **Net-Buy-Pumpet Dashboard**\n\n' +
    '📊 **Current Status:**\n' +
    `🎯 Token: ${session.mint ? `${session.mint.slice(0, 8)}...` : '❌ Not configured'}\n` +
    `🤖 Status: ${running ? '🟢 Pumping Active' : '🔴 Stopped'}\n` +
    `🎭 Wallets: ${multiWallet.getActiveWallets().length} loaded\n\n` +
    '👇 **Choose an action:**',
    { ...getMainMenu(), parse_mode: 'Markdown' }
  );
});

bot.action('main_menu', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  ctx.editMessageText(
    '🤖 **Net-Buy-Pumpet Dashboard**\n\n' +
    '📊 **Current Status:**\n' +
    `🎯 Token: ${session.mint ? `${session.mint.slice(0, 8)}...` : '❌ Not configured'}\n` +
    `🤖 Status: ${running ? '🟢 Pumping Active' : '🔴 Stopped'}\n` +
    `🎭 Wallets: ${multiWallet.getActiveWallets().length} loaded\n\n` +
    '👇 **Choose an action:**',
    { ...getMainMenu(), parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

bot.action('start_setup', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  clearUserSetup(ctx.from.id);
  setUserStep(ctx.from.id, SETUP_STEPS.WAITING_CONTRACT);
  ctx.reply(
    '🔧 **Pump Setup - Step 1/5**\n\n' +
    '🎯 **Enter Token Contract Address:**\n' +
    '💡 Example: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`',
    { ...getSetupMenu(), parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

bot.on('text', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  const userId = ctx.from.id;
  const currentStep = getCurrentStep(userId);
  const text = ctx.message.text.trim();

  if (!currentStep) {
    // fallback for non-setup messages
    ctx.reply('🤖 **Use the menu buttons below.**', getMainMenu());
    return;
  }

  const userData = getUserData(userId);
  try {
    switch (currentStep) {
      case SETUP_STEPS.WAITING_CONTRACT:
        if (text.length < 32 || text.length > 50) {
          return ctx.reply('❌ Invalid contract address.', getSetupMenu());
        }
        try {
          await getRaydiumPoolInfo(text);
          userData.mint = text;
          setUserStep(userId, SETUP_STEPS.WAITING_SOL_AMOUNT);
          ctx.reply(
            '✅ **Token Found!**\n\n🔧 **Setup - Step 2/5**\n\n💰 **Enter SOL Amount per Buy:**\n💡 Examples: `0.1`, `0.5`, `1.0`',
            getSetupMenu()
          );
        } catch (err) {
          ctx.reply(`❌ Token not found: ${err.message}`, getSetupMenu());
        }
        break;

      case SETUP_STEPS.WAITING_SOL_AMOUNT:
        const solAmount = parseFloat(text);
        if (isNaN(solAmount) || solAmount <= 0 || solAmount > 100) {
          return ctx.reply('❌ Please enter a number between 0.01 and 100.', getSetupMenu());
        }
        userData.buySol = solAmount;
        setUserStep(userId, SETUP_STEPS.WAITING_SELL_PCT);
        ctx.reply(
          '✅ **SOL Amount Set!**\n\n🔧 **Setup - Step 3/5**\n\n📈 **Enter Sell Percentage:**\n💡 Examples: `0`, `25`, `50`, `100`',
          getSetupMenu()
        );
        break;

      case SETUP_STEPS.WAITING_SELL_PCT:
        const sellPct = parseInt(text);
        if (isNaN(sellPct) || sellPct < 0 || sellPct > 100) {
          return ctx.reply('❌ Enter 0-100.', getSetupMenu());
        }
        userData.sellPct = sellPct;
        setUserStep(userId, SETUP_STEPS.WAITING_DELAY);
        ctx.reply(
          '✅ **Sell % Set!**\n\n🔧 **Setup - Step 4/5**\n\n⏱️ **Enter Delay Between Rounds (seconds):**\n💡 Examples: `1`, `5`, `10`',
          getSetupMenu()
        );
        break;

      case SETUP_STEPS.WAITING_DELAY:
        const delay = parseInt(text);
        if (isNaN(delay) || delay < 1 || delay > 300) {
          return ctx.reply('❌ Enter 1-300 seconds.', getSetupMenu());
        }
        userData.delaySec = delay;
        setUserStep(userId, SETUP_STEPS.WAITING_MULTI_BUYS);
        ctx.reply(
          '✅ **Delay Set!**\n\n🔧 **Setup - Step 5/5**\n\n🔄 **Enter Multi-Buys per Cycle (1-10):**\n💡 Examples: `1`, `3`, `5`',
          getSetupMenu()
        );
        break;

      case SETUP_STEPS.WAITING_MULTI_BUYS:
        const multiBuys = parseInt(text);
        if (isNaN(multiBuys) || multiBuys < 1 || multiBuys > 10) {
          return ctx.reply('❌ Enter 1-10 buys.', getSetupMenu());
        }
        userData.multiBuys = multiBuys;
        setUserStep(userId, SETUP_STEPS.CONFIRMATION);

        const confirmKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirm & Save', 'confirm_setup')],
          [Markup.button.callback('❌ Cancel Setup', 'cancel_setup')],
          [Markup.button.callback('🔄 Start Over', 'start_setup')],
          [Markup.button.callback('🏠 Main Menu', 'main_menu')]
        ]);

        ctx.reply(
          '🎉 **Setup Complete!**\n\n' +
          `🎯 Token: ${userData.mint}\n` +
          `💰 Buy: ${userData.buySol} SOL\n` +
          `📈 Sell: ${userData.sellPct}%\n` +
          `⏱️ Delay: ${userData.delaySec}s\n` +
          `🔄 Multi-Buys: ${userData.multiBuys}\n\n` +
          '✅ Ready to save?',
          confirmKeyboard
        );
        break;
    }
  } catch (err) {
    ctx.reply(`❌ Setup error: ${err.message}`, getSetupMenu());
    clearUserSetup(userId);
  }
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
  ctx.reply('🎉 **Configuration Saved!**\n\n' + showCurrentConfig(), getMainMenu());
  ctx.answerCbQuery();
});

bot.action('cancel_setup', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  clearUserSetup(ctx.from.id);
  ctx.reply('❌ **Setup Cancelled**', getMainMenu());
  ctx.answerCbQuery();
});

bot.action('refresh_status', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  ctx.reply(showCurrentConfig() + `\n🔄 **Bot Status:** ${running ? '🟢 Pumping Active' : '🔴 Stopped'}`, getMainMenu());
  ctx.answerCbQuery();
});

bot.action('start_pump', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (running) return ctx.answerCbQuery('Already running!');
  if (!session.mint) return ctx.answerCbQuery('Complete setup first!');
  running = true;
  ctx.reply('🔥 **PUMP STARTED!**\n\n' + showCurrentConfig(), getMainMenu());
  startPumpLoop(ctx);
});

bot.action('stop_pump', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (!running) return ctx.answerCbQuery('Not running!');
  running = false;
  ctx.reply('⏹️ **Pump will stop after current cycle.**', getMainMenu());
  ctx.answerCbQuery();
});

bot.action('sell_all_confirm', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (!session.mint) return ctx.answerCbQuery('No token configured!');
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🚨 YES, SELL ALL', 'sell_all_execute')],
    [Markup.button.callback('❌ Cancel', 'main_menu')]
  ]);
  ctx.reply('🚨 **SELL ALL TOKENS?** ⚠️ Cannot be undone.', keyboard);
  ctx.answerCbQuery();
});

bot.action('sell_all_execute', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  try {
    let results;
    if (session.mevProtection) results = await sellTokenMEVProtected(session.mint, 100);
    else results = await sellTokenSingle(session.mint, 100);
    const txLinks = Array.isArray(results)
      ? results.map((tx, i) => `[Tx${i + 1}](https://solscan.io/tx/${tx})`).join(' ')
      : `[Tx](https://solscan.io/tx/${results})`;
    ctx.reply('✅ **All Tokens Sold!**\n\n📊 ' + txLinks, getMainMenu());
  } catch (err) {
    ctx.reply(`❌ Sell failed: ${err.message}`, getMainMenu());
  }
  ctx.answerCbQuery();
});

bot.action('advanced_menu', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  const msg =
    '🛡️ **Advanced Controls**\n\n' +
    `🛡️ MEV Protection: ${session.mevProtection ? '🟢 ON' : '🔴 OFF'}\n` +
    `🎭 Multi-Wallet: ${session.multiWallet ? '🟢 ON' : '🔴 OFF'}`;
  ctx.editMessageText(msg, Markup.inlineKeyboard([
    [Markup.button.callback('🛡️ Toggle MEV Protection', 'toggle_mev')],
    [Markup.button.callback('🎭 Toggle Multi-Wallet', 'toggle_multiwallet')],
    [Markup.button.callback('🔍 MEV Analysis', 'analyze_mev')],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')]
  ]));
  ctx.answerCbQuery();
});

bot.action('toggle_mev', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  session.mevProtection = !session.mevProtection;
  ctx.reply(`🛡️ MEV Protection **${session.mevProtection ? 'ENABLED' : 'DISABLED'}**`, getMainMenu());
  ctx.answerCbQuery();
});

bot.action('toggle_multiwallet', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  const wallets = multiWallet.getActiveWallets().length;
  if (wallets < 2) {
    ctx.answerCbQuery(`Need ≥2 wallets. Loaded: ${wallets}`);
    return;
  }
  session.multiWallet = !session.multiWallet;
  ctx.reply(`🎭 Multi-Wallet **${session.multiWallet ? 'ENABLED' : 'DISABLED'}**`, getMainMenu());
  ctx.answerCbQuery();
});

bot.action('analyze_mev', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (!session.mint) return ctx.answerCbQuery('Set token first!');
  ctx.reply('🔍 **Analyzing MEV Activity...**');
  try {
    const a = await mevProtection.detectMEVActivity(session.mint);
    ctx.reply(
      `🔍 **MEV Analysis**\n\n` +
      `🎯 Token: ${session.mint.slice(0, 8)}...\n` +
      `📊 Risk: ${a.riskScore.toFixed(2)}\n` +
      `🛡️ Recommendation: ${a.recommendation.toUpperCase()}`
    );
  } catch (err) {
    ctx.reply(`❌ Analysis failed: ${err.message}`);
  }
  ctx.answerCbQuery();
});

bot.action('multiwallet_status', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  const wallets = multiWallet.getActiveWallets();
  let msg = `🎭 **Multi-Wallet Status**\n\n👥 **Total:** ${wallets.length}`;
  wallets.forEach((w, i) => {
    msg += `\n${i + 1}. ${w.role.toUpperCase()} – ${w.keypair.publicKey.toString().slice(0, 8)}...`;
  });
  ctx.reply(msg, getMainMenu());
  ctx.answerCbQuery();
});

// ---------- PUMP LOOP ----------
async function startPumpLoop(ctx) {
  if (!session.mint) return;
  let buyAmount = session.buySol;
  let cycleCount = 0;
  while (running && !isShuttingDown) {
    try {
      cycleCount++;
      await ctx.telegram.sendMessage(ADMIN, `🔄 **Cycle ${cycleCount}** – ${buyAmount.toFixed(4)} SOL`);
      for (let i = 0; i < session.multiBuys; i++) {
        if (!running || isShuttingDown) break;
        let results;
        if (session.multiWallet && multiWallet.getActiveWallets().length > 1) {
          results = await multiWallet.executeCoordinatedBuy(session.mint, buyAmount, session.mevProtection);
          for (const r of results) {
            await ctx.telegram.sendMessage(
              ADMIN,
              `${r.tx ? `✅ ${r.wallet.toUpperCase()} – ${r.amount.toFixed(4)} SOL\n📊 https://solscan.io/tx/${r.tx}` : `❌ ${r.wallet.toUpperCase()} – ${r.error}`}`
            );
          }
        } else if (session.mevProtection) {
          results = await buyTokenMEVProtected(session.mint, buyAmount);
          for (const tx of results) {
            await ctx.telegram.sendMessage(ADMIN, `✅ Buy – https://solscan.io/tx/${tx}`);
          }
        } else {
          const tx = await buyTokenSingle(session.mint, buyAmount);
          await ctx.telegram.sendMessage(ADMIN, `✅ Buy – https://solscan.io/tx/${tx}`);
        }
        if (i < session.multiBuys - 1) await new Promise(res => setTimeout(res, 1000));
      }
      if (session.sellPct > 0 && running && !isShuttingDown) {
        let sellRes;
        if (session.mevProtection) sellRes = await sellTokenMEVProtected(session.mint, session.sellPct);
        else sellRes = await sellTokenSingle(session.mint, session.sellPct);
        const sellLinks = Array.isArray(sellRes)
          ? sellRes.map(t => `https://solscan.io/tx/${t}`).join(' ')
          : `https://solscan.io/tx/${sellRes}`;
        await ctx.telegram.sendMessage(ADMIN, `📈 **Sold ${session.sellPct}%** – ${sellLinks}`);
      }
      buyAmount *= session.buyScale;
      const delayMs = Math.max(500, session.delaySec * 1000 * (0.8 + Math.random() * 0.4));
      await new Promise(res => setTimeout(res, delayMs));
    } catch (err) {
      await ctx.telegram.sendMessage(ADMIN, `❌ Cycle ${cycleCount} error: ${err.message}`);
    }
  }
  await ctx.telegram.sendMessage(ADMIN, '⏹️ **Pump Stopped**', getMainMenu());
}

// ---------- HEALTH & SHUTDOWN ----------
const port = process.env.PORT || 3000;
const server = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
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
    res.writeHead(404);
    res.end('Not Found');
  }
});
server.listen(port, () => console.log(`🌐 Health check on port ${port}`));

function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  running = false;
  console.log('🔄 Shutting down...');
  bot.stop();
  process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ---------- START ----------
async function startBot() {
  try {
    await bot.launch({ dropPendingUpdates: true });
    console.log('✅ Net-Buy-Pumpet bot running!');
    console.log(`🎭 Multi-wallet system: ${multiWallet.getActiveWallets().length} wallets`);
  } catch (err) {
    console.error('❌ Failed to start bot:', err);
    process.exit(1);
  }
}
startBot();
