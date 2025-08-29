// index.js
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
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction
} from '@solana/spl-token';
import { Liquidity, jsonInfo2PoolKeys, TokenAmount, Token as RToken } from '@raydium-io/raydium-sdk';

// === CONFIGURATION ===
const {
  TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
  ADMIN_CHAT_ID: ADMIN,
  SOLANA_PRIVATE_KEY: PRIVATE_KEY
} = process.env;

const connection = new Connection(process.env.RPC || 'https://api.mainnet-beta.solana.com');
const payer      = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const bot        = new Telegraf(TELEGRAM_TOKEN);

let running      = false;   // ← only once
let multiBuyMode = false;
let session      = {
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
  const ata  = await getATA(mint, owner);
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

async function wrapSOL(amount) {
  const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
  const ata  = await ensureATA(WSOL, payer.publicKey);
  const raw  = await connection.getTokenAccountBalance(ata);
  const bal  = Number(raw.value.amount);
  if (bal < amount) {
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey:   ata,
        lamports:   amount
      }),
      createSyncNativeInstruction(ata)
    );
    await connection.sendTransaction(wrapTx, [payer], { skipPreflight: false, preflightCommitment: 'confirmed' });
  }
  return ata;
}

async function buyToken(mint, solAmount) {
  const pool     = await getRaydiumPoolInfo(mint);
  const poolKeys = jsonInfo2PoolKeys(pool);
  const base     = new RToken(pool.baseMint, 6, 'TOKEN', 'TOKEN');
  const quote    = new RToken(pool.quoteMint, 9, 'SOL', 'QUOTE');
  const amountIn = new TokenAmount(quote, solAmount * LAMPORTS_PER_SOL);

  const userWSOL  = await wrapSOL(amountIn.raw.toNumber());
  const userToken = await ensureATA(base.mint, payer.publicKey);

  const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
    connection,
    poolKeys,
    userKeys: {
      tokenAccountIn:  userWSOL,
      tokenAccountOut: userToken,
      owner:           payer.publicKey,
      payer:           payer.publicKey
    },
    amountIn,
    amountOutMin: new TokenAmount(base, 1),
    fixedSide: 'in',
    makeTxVersion: 0
  });

  const tx = new Transaction();
  innerTransactions.forEach(({ instructions }) => instructions.forEach(ix => tx.add(ix)));
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  return await connection.sendTransaction(tx, [payer], { skipPreflight: false, preflightCommitment: 'confirmed' });
}

async function sellToken(mint, sellPct) {
  const pool     = await getRaydiumPoolInfo(mint);
  const poolKeys = jsonInfo2PoolKeys(pool);
  const base     = new RToken(pool.baseMint, 6, 'TOKEN', 'TOKEN');
  const quote    = new RToken(pool.quoteMint, 9, 'SOL', 'QUOTE');

  const userToken = await ensureATA(base.mint, payer.publicKey);
  const userWSOL  = await ensureATA(quote.mint, payer.publicKey);

  const rawBal = await connection.getTokenAccountBalance(userToken);
  const amountIn = new TokenAmount(base, Math.floor(Number(rawBal.value.amount) * (sellPct / 100)));

  const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
    connection,
    poolKeys,
    userKeys: {
      tokenAccountIn:  userToken,
      tokenAccountOut: userWSOL,
      owner:           payer.publicKey,
      payer:           payer.publicKey
    },
    amountIn,
    amountOutMin: new TokenAmount(quote, 1),
    fixedSide: 'in',
    makeTxVersion: 0
  });

  const tx = new Transaction();
  innerTransactions.forEach(({ instructions }) => instructions.forEach(ix => tx.add(ix)));
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  return await connection.sendTransaction(tx, [payer], { skipPreflight: false, preflightCommitment: 'confirmed' });
}

// === TELEGRAM HANDLERS ===
function configMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Set/Change Token', 'set_mint')],
    [Markup.button.callback('Buy -', 'buy_minus'), Markup.button.callback(`${session.buySol} SOL`, 'noop'), Markup.button.callback('Buy +', 'buy_plus')],
    [Markup.button.callback('Sell % -', 'sell_minus'), Markup.button.callback(`${session.sellPct}%`, 'noop'), Markup.button.callback('Sell % +', 'sell_plus')],
    [Markup.button.callback('Delay -', 'delay_minus'), Markup.button.callback(`${session.delaySec}s`, 'noop'), Markup.button.callback('Delay +', 'delay_plus')],
    [Markup.button.callback(`Multi-Buy: ${multiBuyMode ? 'ON' : 'OFF'}`, 'multiBuyToggle')],
    [Markup.button.callback('✅ Confirm & Save', 'config_save')],
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
  edit ? ctx.editMessageText(text, configMenu()).catch(() => {}) : ctx.reply(text, configMenu());
}

bot.start(ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  ctx.reply('Welcome to Net-Buy-Pumpet!', configMenu());
});

bot.command('config', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  sendConfig(ctx);
});

bot.action('set_mint', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  ctx.reply('📝 Send the token contract address (mint).');
  bot.once('text', async ctx2 => {
    if (ctx2.from.id.toString() !== ADMIN) return;
    const mint = ctx2.message.text?.trim();
    if (!mint || mint.length < 32) return ctx2.reply('❌ Invalid mint.');
    session.mint = mint;
    ctx2.reply(`✅ Mint set to ${session.mint}`);
    sendConfig(ctx2);
  });
  ctx.answerCbQuery();
});

const sliderActions = [
  ['buy_minus',       () => session.buySol   = Math.max(0.01, +(session.buySol   - 0.01).toFixed(2))],
  ['buy_plus',        () => session.buySol   = +(session.buySol   + 0.01).toFixed(2)],
  ['sell_minus',      () => session.sellPct  = Math.max(0,    session.sellPct  - 1)],
  ['sell_plus',       () => session.sellPct  = Math.min(100,  session.sellPct  + 1)],
  ['delay_minus',     () => session.delaySec = Math.max(1,    session.delaySec - 1)],
  ['delay_plus',      () => session.delaySec += 1],
  ['multiBuyToggle',  () => multiBuyMode     = !multiBuyMode]
];

sliderActions.forEach(([action, fn]) => {
  bot.action(action, ctx => {
    fn();
    sendConfig(ctx, true);
    ctx.answerCbQuery();
  });
});

bot.action('config_save', ctx => {
  ctx.reply('✅ Pump configuration updated and saved!');
  ctx.answerCbQuery();
});

bot.action('sell_all', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return ctx.answerCbQuery('Not authorized.');
  if (!session.mint) return ctx.answerCbQuery('Set the mint address first!');
  try {
    const tx = await sellToken(session.mint, 100);
    ctx.reply(`✅ Sold ALL tokens! Tx: https://solscan.io/tx/${tx}`);
  } catch (err) {
    ctx.reply(`❌ Sell all failed: ${err.message}`);
  }
  ctx.answerCbQuery();
});

bot.action('noop', ctx => ctx.answerCbQuery());

bot.command('pump', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (running) return ctx.reply('⏳ Pump already in progress.');
  if (!session.mint) return ctx.reply('❌ Set the mint address first! Use /config.');

  running = true;
  ctx.reply(`🔥 Pump started! Multi-Buy: ${multiBuyMode ? 'ON' : 'OFF'}`);

  let buyAmount = session.buySol;
  while (running) {
    try {
      const count = multiBuyMode ? session.multiBuys : 1;
      for (let i = 0; i < count; i++) {
        const tx = await buyToken(session.mint, buyAmount);
        ctx.reply(`✅ Buy Tx: https://solscan.io/tx/${tx}`);
      }
      if (session.sellPct > 0) {
        const tx = await sellToken(session.mint, session.sellPct);
        ctx.reply(`✅ Sell Tx: https://solscan.io/tx/${tx}`);
      }
      buyAmount *= session.buyScale;
      const jitter   = 0.8 + Math.random() * 0.4;
      const delayMs  = Math.max(0.5, session.delaySec * jitter) * 1000;
      await new Promise(res => setTimeout(res, delayMs));
    } catch (e) {
      ctx.reply(`❌ Round error: ${e.message}`);
    }
  }
  ctx.reply('⏹️ Pump stopped.');
});

bot.command('stop', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  running = false;
  ctx.reply('⏹️ Pump will stop after the current round.');
});

bot.launch()
   .then(() => console.log('Bot running'))
   .catch(console.error);

process.on('SIGINT', () => { running = false; bot.stop('SIGINT'); });
process.on('SIGTERM', () => { running = false; bot.stop('SIGTERM'); });
// Health endpoint for Render free Web Service
import http from 'http';
http.createServer((_, res) => res.end('OK')).listen(process.env.PORT || 3000);
