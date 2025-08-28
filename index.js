// Load env vars
import 'dotenv/config';

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
import {
  Token,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { buildSwapInstruction } from '@raydium-io/raydium-sdk';

// === CONFIGURATION ===
const {
  TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
  ADMIN_CHAT_ID:        ADMIN,
  SOLANA_PRIVATE_KEY:   PRIVATE_KEY
} = process.env;

const connection = new Connection();
const payer      = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const bot        = new Telegraf(TELEGRAM_TOKEN);

let running      = false;
let multiBuyMode = false;

let session = {
  mint:      '',
  buySol:    0.1,
  sellPct:   0,
  delaySec:  2,
  buyScale:  1.1,
  multiBuys: 3
};

// === HELPERS ===

async function getRaydiumPoolInfo(mintAddress) {
  const url   = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
  const { official, unOfficial } = await fetch(url).then(r => r.json());

  for (const poolId in { ...official, ...unOfficial }) {
    const pool = official[poolId] || unOfficial[poolId];
    if (pool.baseMint === mintAddress || pool.quoteMint === mintAddress) {
      pool.id = poolId;
      return pool;
    }
  }

  throw new Error(`No Raydium pool found for mint: ${mintAddress}`);
}

async function getATA(mint, owner) {
  return Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    new PublicKey(mint),
    owner
  );
}

async function ensureATA(mint, owner) {
  const ata  = await getATA(mint, owner);
  const info = await connection.getAccountInfo(ata);

  if (!info) {
    const token = new Token(connection, new PublicKey(mint), TOKEN_PROGRAM_ID, payer);
    const tx = new Transaction().add(
      Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        new PublicKey(mint),
        ata,
        owner,
        payer.publicKey
      )
    );
    await connection.sendTransaction(tx, [payer], {
      skipPreflight:       false,
      preflightCommitment: 'confirmed'
    });
  }
  return ata;
}

async function buyToken(mint, solAmount) {
  const pool       = await getRaydiumPoolInfo(mint);
  const buyingBase = pool.baseMint === mint;

  const WSOL       = 'So11111111111111111111111111111111111111112';
  const tokenIn    = buyingBase ? WSOL : mint;
  const tokenOut   = buyingBase ? mint : WSOL;
  const fromATA    = await ensureATA(WSOL, payer.publicKey);
  let amountIn     = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const balanceRaw = await connection.getTokenAccountBalance(fromATA);
  const balance    = Number(balanceRaw.value.amount);

  if (balance < amountIn) {
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey:   fromATA,
        lamports:   amountIn
      }),
      Token.createSyncNativeInstruction(TOKEN_PROGRAM_ID, fromATA)
    );
    await connection.sendTransaction(wrapTx, [payer], {
      skipPreflight:       false,
      preflightCommitment: 'confirmed'
    });
  }

  const outATA = await ensureATA(tokenOut, payer.publicKey);

  const swapIx = await buildSwapInstruction({
    poolKeys: pool,
    userKeys: {
      tokenAccountIn:  fromATA,
      tokenAccountOut: outATA,
      owner:           payer.publicKey,
      payer:           payer.publicKey
    },
    amountIn,
    minAmountOut: 1,
    direction:    buyingBase ? 'quote2base' : 'base2quote'
  });

  const tx = new Transaction();
  swapIx.innerTransactions.forEach(({ instructions }) =>
    instructions.forEach(ix => tx.add(ix))
  );
  const sig = await connection.sendTransaction(tx, [payer], {
    skipPreflight:       false,
    preflightCommitment: 'confirmed'
  });
  return sig;
}

async function sellToken(mint, sellPct) {
  const pool     = await getRaydiumPoolInfo(mint);
  const baseMint = pool.baseMint;
  const WSOL     = 'So11111111111111111111111111111111111111112';

  const baseATA = await ensureATA(baseMint, payer.publicKey);
  const wsolATA = await ensureATA(WSOL, payer.publicKey);

  const balRaw   = await connection.getTokenAccountBalance(baseATA);
  const bal      = Number(balRaw.value.amount);
  const amountIn = Math.floor(bal * (sellPct / 100));

  if (amountIn < 1) {
    throw new Error('Not enough token balance to sell');
  }

  const swapIx = await buildSwapInstruction({
    poolKeys: pool,
    userKeys: {
      tokenAccountIn:  baseATA,
      tokenAccountOut: wsolATA,
      owner:           payer.publicKey,
      payer:           payer.publicKey
    },
    amountIn,
    minAmountOut: 1,
    direction:    'base2quote'
  });

  const tx = new Transaction();
  swapIx.innerTransactions.forEach(({ instructions }) =>
    instructions.forEach(ix => tx.add(ix))
  );
  const sig = await connection.sendTransaction(tx, [payer], {
    skipPreflight:       false,
    preflightCommitment: 'confirmed'
  });
  return sig;
}

// === TELEGRAM UI ===

function configMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Set/Change Token', 'set_mint')],
    [
      Markup.button.callback('Buy -', 'buy_minus'),
      Markup.button.callback(`${session.buySol} SOL`, 'noop'),
      Markup.button.callback('Buy +', 'buy_plus')
    ],
    [
      Markup.button.callback('Sell % -', 'sell_minus'),
      Markup.button.callback(`${session.sellPct}%`, 'noop'),
      Markup.button.callback('Sell % +', 'sell_plus')
    ],
    [
      Markup.button.callback('Delay -', 'delay_minus'),
      Markup.button.callback(`${session.delaySec}s`, 'noop'),
      Markup.button.callback('Delay +', 'delay_plus')
    ],
    [Markup.button.callback(`Multi-Buy: ${multiBuyMode ? 'ON' : 'OFF'}`, 'multiBuyToggle')],
    [Markup.button.callback('✅ Confirm and Save', 'config_save')],
    [Markup.button.callback('💰 Sell All Tokens', 'sell_all')]
  ]);
}

function sendConfig(ctx, edit = false) {
  const text = [
    '🛠️ Pump Bot Configuration:',
    `Token Contract (Mint): ${session.mint || 'Not set'}`,
    `Buy Amount: ${session.buySol} SOL`,
    `Sell %: ${session.sellPct}%`,
    `Delay: ${session.delaySec}s`,
    `Multi-Buy: ${multiBuyMode ? 'ON' : 'OFF'}`
  ].join('\n');

  if (edit) {
    ctx.editMessageText(text, configMenu()).catch(() => {});
  } else {
    ctx.reply(text, configMenu());
  }
}

// === HANDLERS ===

bot.start(ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  ctx.reply(
    'Welcome to Net-Buy-Pumpet!\nUse /config to set parameters and /pump to start.',
    configMenu()
  );
});

bot.command('config', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  sendConfig(ctx);
});

bot.action('set_mint', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  ctx.reply('📝 Send the token mint address.');
  bot.once('text', async ctx2 => {
    if (ctx2.from.id.toString() !== ADMIN) return;
    const mint = ctx2.message.text?.trim();
    if (!mint || mint.length < 32) {
      return ctx2.reply('❌ Invalid mint address.');
    }
    session.mint = mint;
    ctx2.reply(`✅ Mint set: ${session.mint}`);
    sendConfig(ctx2);
  });
  ctx.answerCbQuery();
});

// slider and toggle callbacks
;[
  ['buy_minus', () => session.buySol = Math.max(0.01, +(session.buySol - 0.01).toFixed(2))],
  ['buy_plus',  () => session.buySol = +(session.buySol + 0.01).toFixed(2))],
  ['sell_minus',() => session.sellPct = Math.max(0, session.sellPct - 1)],
  ['sell_plus', () => session.sellPct = Math.min(100, session.sellPct + 1))],
  ['delay_minus',() => session.delaySec = Math.max(1, session.delaySec - 1))],
  ['delay_plus', () => session.delaySec += 1)],
  ['multiBuyToggle',() => multiBuyMode = !multiBuyMode]
].forEach(([act, fn]) => {
  bot.action(act, ctx => {
    fn();
    sendConfig(ctx, true);
    ctx.answerCbQuery();
  });
});

bot.action('config_save', ctx => {
  ctx.reply('✅ Configuration saved.');
  ctx.answerCbQuery();
});

bot.action('sell_all', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) {
    return ctx.answerCbQuery('Not authorized.');
  }
  if (!session.mint) {
    return ctx.answerCbQuery('Set mint first!');
  }
  try {
    const tx = await sellToken(session.mint, 100);
    ctx.reply(`✅ Sold all! Tx: https://solscan.io/tx/${tx}`);
  } catch (e) {
    ctx.reply(`❌ Sell failed: ${e.message}`);
  }
  ctx.answerCbQuery();
});

bot.action('noop', ctx => ctx.answerCbQuery());

bot.command('pump', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (running) return ctx.reply('⏳ Already pumping.');
  if (!session.mint) return ctx.reply('❌ Set mint via /config.');

  running = true;
  ctx.reply(`🔥 Pump started! Multi-Buy: ${multiBuyMode ? 'ON' : 'OFF'}`);

  let buyAmt = session.buySol;
  while (running) {
    try {
      const count = multiBuyMode ? session.multiBuys : 1;
      for (let i = 0; i < count; i++) {
        try {
          const tx = await buyToken(session.mint, buyAmt);
          ctx.reply(`✅ Buy: https://solscan.io/tx/${tx}`);
        } catch (e) {
          ctx.reply(`❌ Buy error: ${e.message}`);
        }
      }

      if (session.sellPct > 0) {
        try {
          const tx = await sellToken(session.mint, session.sellPct);
          ctx.reply(`✅ Sell: https://solscan.io/tx/${tx}`);
        } catch (e) {
          ctx.reply(`❌ Sell error: ${e.message}`);
        }
      }

      buyAmt *= session.buyScale;
      const jitterMs = Math.max(0.5, session.delaySec * (0.8 + Math.random() * 0.4)) * 1000;
      await new Promise(r => setTimeout(r, jitterMs));
    } catch (e) {
      ctx.reply(`❌ Round error: ${e.message}`);
    }
  }

  ctx.reply('⏹️ Pump stopped.');
});

bot.command('stop', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  running = false;
  ctx.reply('⏹️ Will stop after current round.');
});

bot
  .launch()
  .then(() => bot.telegram.sendMessage(ADMIN, '🤖 Net-Buy-Pumpet active!'))
  .catch(console.error);

process.on('SIGINT', () => {
  running = false;
  bot.stop('SIGINT');
});
process.on('SIGTERM', () => {
  running = false;
  bot.stop('SIGTERM');
});
