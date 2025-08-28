// index.js

import dotenv from 'dotenv';
import { Connection, clusterApiUrl, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction
} from '@solana/spl-token';
import {
  getPoolId,
  getRaydiumSwapInfo,
  buildSwapTransaction
} from '@raydium-io/raydium-sdk';
import { Telegraf, Markup, session as telegrafSession } from 'telegraf';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// --- Solana & Wallet Setup ---
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
const wallet     = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.SECRET_KEY))
);

// --- Telegram Bot Setup ---
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(telegrafSession());

// --- Default Session Configuration ---
const defaultSession = {
  poolId: process.env.POOL_ID,    // Raydium pool ID (base58)
  buyPerc:  1,                    // % slippage for buy
  sellPerc: 1,                    // % slippage for sell
  buySol:   0.01,                 // SOL to spend on each buy
  sellSol:  0.01,                 // SOL to spend on each sell
  active:   false,                // pump loop toggle
};

// --- On‐chain Helpers ---
async function getPoolInfo(poolId) {
  return await getRaydiumSwapInfo({ poolId, connection });
}

async function ensureATA(mint) {
  const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
  const acc = await connection.getAccountInfo(ata);
  if (!acc) {
    const tx = await createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      ata,
      wallet.publicKey,
      mint
    );
    await connection.sendTransaction(tx, [wallet], {
      skipPreflight: true,
      preflightCommitment: 'confirmed'
    });
  }
  return ata;
}

// Build & send a Raydium swap TX
async function swap({ poolKeys, amountIn, slippageBps }) {
  const { transaction } = await buildSwapTransaction({
    connection,
    poolKeys,
    userKeys: {
      owner: wallet.publicKey,
      fromTokenAccount: undefined, // SDK will infer ATA
      toTokenAccount:   undefined, // SDK will infer ATA
    },
    amountIn,
    slippageBps,
  });

  const txid = await connection.sendTransaction(transaction, [wallet], {
    skipPreflight: true,
    preflightCommitment: 'confirmed'
  });
  return txid;
}

// --- UI Generators ---
const sliders = ['buyPerc', 'sellPerc', 'buySol', 'sellSol'];

function generateSliderKeyboard(session) {
  const buttons = sliders.flatMap((key) => [
    Markup.button.callback(`– ${key}`, `slider_${key}_-1`),
    Markup.button.callback(`+ ${key}`, `slider_${key}_+1`),
    Markup.button.callback(`${key}: ${session[key]}`, 'noop'),
    Markup.button.callback(`reset ${key}`, `slider_${key}_reset`)
  ]);
  return Markup.inlineKeyboard(buttons, { columns: 4 });
}

function generateToggleKeyboard(session) {
  return Markup.inlineKeyboard([
    Markup.button.callback(
      session.active ? '🛑 Stop Pump' : '✅ Start Pump',
      'toggle_active'
    ),
    Markup.button.callback('+ buySol',   'buy_plus'),
    Markup.button.callback('- buySol',   'buy_minus'),
    Markup.button.callback('+ sellSol',  'sell_plus'),
    Markup.button.callback('- sellSol',  'sell_minus')
  ], { columns: 2 });
}

// --- Telegram Handlers ---
bot.start((ctx) => {
  ctx.session = ctx.session || { ...defaultSession };
  ctx.reply(
    'Welcome to Net-Buy Pumpet! Use /config to fine-tune or /pump to launch.',
    generateToggleKeyboard(ctx.session)
  );
});

bot.command('config', (ctx) => {
  ctx.session = ctx.session || { ...defaultSession };
  ctx.reply(
    'Adjust your pump parameters:',
    generateSliderKeyboard(ctx.session)
  );
});

// Slider adjustments
bot.action(/slider_(.+?)_(.+)/, (ctx) => {
  const [, key, op] = ctx.match;
  const session = ctx.session;

  if (op === 'reset') {
    session[key] = defaultSession[key];
  } else {
    const step = key.includes('Perc') ? 1 : 0.01;
    const delta = Number(op) * step;
    const raw   = session[key] + delta;
    session[key] = key.includes('Perc')
      ? Math.max(0, Math.round(raw))
      : Number(raw.toFixed(2));
  }

  return ctx.editMessageReplyMarkup(
    generateSliderKeyboard(session)
  );
});

// Toggle pump on/off
bot.action('toggle_active', (ctx) => {
  ctx.session.active = !ctx.session.active;
  ctx.editMessageReplyMarkup(
    generateToggleKeyboard(ctx.session)
  );
  return ctx.answerCbQuery(
    `Pump ${ctx.session.active ? 'resumed' : 'paused'}.`
  );
});

// Increment/decrement SOL amounts
bot.action('buy_plus',   (ctx) => {
  ctx.session.buySol = Number((ctx.session.buySol + 0.01).toFixed(2));
  return ctx.editMessageReplyMarkup(generateToggleKeyboard(ctx.session));
});
bot.action('buy_minus',  (ctx) => {
  ctx.session.buySol = Number((ctx.session.buySol - 0.01).toFixed(2));
  return ctx.editMessageReplyMarkup(generateToggleKeyboard(ctx.session));
});
bot.action('sell_plus',  (ctx) => {
  ctx.session.sellSol = Number((ctx.session.sellSol + 0.01).toFixed(2));
  return ctx.editMessageReplyMarkup(generateToggleKeyboard(ctx.session));
});
bot.action('sell_minus', (ctx) => {
  ctx.session.sellSol = Number((ctx.session.sellSol - 0.01).toFixed(2));
  return ctx.editMessageReplyMarkup(generateToggleKeyboard(ctx.session));
});

// No‐op button (just to show current value)
bot.action('noop', (ctx) => ctx.answerCbQuery(), { drop_pending_updates: true });

// Pump loop
bot.command('pump', async (ctx) => {
  ctx.session = ctx.session || { ...defaultSession };
  const poolKeys = await getPoolId(ctx.session.poolId).then((id) => id);

  ctx.reply('🚀 Pump loop started! Check your console for TX IDs.');

  while (ctx.session.active) {
    try {
      // BUY phase
      const buyLamports = ctx.session.buySol * LAMPORTS_PER_SOL;
      const buySlippage = Math.floor(ctx.session.buyPerc * 100); // bps
      const buyTx = await swap({
        poolKeys,
        amountIn: buyLamports,
        slippageBps: buySlippage
      });
      console.log('BUY tx:', buyTx);

      await new Promise((r) => setTimeout(r, 5000));

      // SELL phase
      const sellLamports = ctx.session.sellSol * LAMPORTS_PER_SOL;
      const sellSlippage = Math.floor(ctx.session.sellPerc * 100); // bps
      const sellTx = await swap({
        poolKeys,
        amountIn: sellLamports,
        slippageBps: sellSlippage
      });
      console.log('SELL tx:', sellTx);

      await new Promise((r) => setTimeout(r, 5000));
    } catch (err) {
      console.error('Pump error:', err);
      ctx.reply(`Error in pump loop: ${err.message}`);
      ctx.session.active = false;
    }
  }
});

// Immediate halt
bot.command('stop', (ctx) => {
  ctx.session.active = false;
  ctx.reply('🛑 Pump halted.');
});

// Single‐shot sell
bot.command('sell_all', async (ctx) => {
  ctx.session = ctx.session || { ...defaultSession };
  const poolKeys = await getPoolId(ctx.session.poolId).then((id) => id);

  try {
    const sellLamports = ctx.session.sellSol * LAMPORTS_PER_SOL;
    const sellSlippage = Math.floor(ctx.session.sellPerc * 100);
    const tx = await swap({
      poolKeys,
      amountIn: sellLamports,
      slippageBps: sellSlippage
    });
    ctx.reply(`✅ Sold: ${tx}`);
  } catch (err) {
    ctx.reply(`❌ Sell failed: ${err.message}`);
  }
});

// Graceful shutdown
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Launch!
bot.launch();
