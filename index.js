// Ensure your package.json has: { "type": "module" }

// Load environment variables
import 'dotenv/config';

// Allow requiring CJS modules in an ES module context
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Core imports
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

// SPL Token ESM imports (no more `Token` class)
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction
} from '@solana/spl-token';

// Import Raydium SDK's CJS build
const { buildSwapInstruction } = require('@raydium-io/raydium-sdk');

// === CONFIGURATION ===
const {
  TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
  ADMIN_CHAT_ID:      ADMIN,
  SOLANA_PRIVATE_KEY: PRIVATE_KEY
} = process.env;

const connection = new Connection();
const payer      = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const bot        = new Telegraf(TELEGRAM_TOKEN);

let running      = false;
let multiBuyMode = false;
let isShuttingDown = false;

let session = {
  mint:      '',    // SPL token mint
  buySol:    0.1,   // SOL per buy
  sellPct:   0,     // % to sell each round
  delaySec:  2,     // Delay between rounds
  buyScale:  1.1,   // Buy scaling factor
  multiBuys: 3      // Rounds per cycle if multiBuyMode
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

// Get the Associated Token Account (ATA) address
async function getATA(mint, owner) {
  return await getAssociatedTokenAddress(
    new PublicKey(mint),
    owner,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

// Ensure ATA exists; create if missing
async function ensureATA(mint, owner) {
  const ata  = await getATA(mint, owner);
  const info = await connection.getAccountInfo(ata);

  if (!info) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,              // payer
        ata,                          // ata address
        owner,                        // token owner
        new PublicKey(mint),          // mint
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await connection.sendTransaction(tx, [payer], {
      skipPreflight:       false,
      preflightCommitment: 'confirmed'
    });
  }

  return ata;
}

// Wrap SOL to WSOL and swap into target token
async function buyToken(mint, solAmount) {
  const pool       = await getRaydiumPoolInfo(mint);
  const buyingBase = (pool.baseMint === mint);

  const WSOL     = 'So11111111111111111111111111111111111111112';
  const fromMint = buyingBase ? WSOL : mint;
  const toMint   = buyingBase ? mint : WSOL;

  const userWSOL    = await ensureATA(WSOL, payer.publicKey);
  const amountIn    = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const rawBalance  = await connection.getTokenAccountBalance(userWSOL);
  const wsolBalance = Number(rawBalance.value.amount);

  // If not enough wrapped SOL, wrap some
  if (wsolBalance < amountIn) {
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey:   userWSOL,
        lamports:   amountIn
      }),
      createSyncNativeInstruction(userWSOL)
    );
    await connection.sendTransaction(wrapTx, [payer], {
      skipPreflight:       false,
      preflightCommitment: 'confirmed'
    });
  }

  const userOutATA = await ensureATA(toMint, payer.publicKey);

  const swapIx = await buildSwapInstruction({
    poolKeys: pool,
    userKeys: {
      tokenAccountIn:  userWSOL,
      tokenAccountOut: userOutATA,
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

  return await connection.sendTransaction(tx, [payer], {
    skipPreflight:       false,
    preflightCommitment: 'confirmed'
  });
}

// Sell a percentage of your token balance back to SOL
async function sellToken(mint, sellPct) {
  const pool     = await getRaydiumPoolInfo(mint);
  const baseMint = pool.baseMint;
  const WSOL     = 'So11111111111111111111111111111111111111112';

  const userBaseATA = await ensureATA(baseMint, payer.publicKey);
  const userWSOL    = await ensureATA(WSOL, payer.publicKey);

  const rawBal   = await connection.getTokenAccountBalance(userBaseATA);
  const bal      = Number(rawBal.value.amount);
  const amountIn = Math.floor(bal * (sellPct / 100));

  if (amountIn < 1) {
    throw new Error('Not enough token balance to sell');
  }

  const swapIx = await buildSwapInstruction({
    poolKeys: pool,
    userKeys: {
      tokenAccountIn:  userBaseATA,
      tokenAccountOut: userWSOL,
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

  return await connection.sendTransaction(tx, [payer], {
    skipPreflight:       false,
    preflightCommitment: 'confirmed'
  });
}

// === TELEGRAM UI & HANDLERS ===

function configMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Set/Change Token', 'set_mint')],
    [Markup.button.callback('Buy -', 'buy_minus'), Markup.button.callback(`${session.buySol} SOL`, 'noop'), Markup.button.callback('Buy +', 'buy_plus')],
    [Markup.button.callback('Sell % -', 'sell_minus'), Markup.button.callback(`${session.sellPct}%`, 'noop'), Markup.button.callback('Sell % +', 'sell_plus')],
    [Markup.button.callback('Delay -', 'delay_minus'), Markup.button.callback(`${session.delaySec}s`, 'noop'), Markup.button.callback('Delay +', 'delay_plus')],
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
  ctx.reply('📝 Please send the token contract address (mint).');
  bot.once('text', async ctx2 => {
    if (ctx2.from.id.toString() !== ADMIN) return;
    const mint = ctx2.message.text?.trim();
    if (!mint || mint.length < 32) {
      return ctx2.reply('❌ Invalid mint address.');
    }
    session.mint = mint;
    ctx2.reply(`✅ Mint set to:\n${session.mint}`);
    sendConfig(ctx2);
  });
  ctx.answerCbQuery();
});

const sliderActions = [
  ['buy_minus',      () => session.buySol   = Math.max(0.01, +(session.buySol   - 0.01).toFixed(2))],
  ['buy_plus',       () => session.buySol   =             +(session.buySol   + 0.01).toFixed(2)],
  ['sell_minus',     () => session.sellPct  = Math.max(0,    session.sellPct  - 1)],
  ['sell_plus',      () => session.sellPct  = Math.min(100,  session.sellPct  + 1)],
  ['delay_minus',    () => session.delaySec = Math.max(1,    session.delaySec - 1)],
  ['delay_plus',     () => session.delaySec += 1],
  ['multiBuyToggle', () => multiBuyMode      = !multiBuyMode]
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
  if (ctx.from.id.toString() !== ADMIN) {
    return ctx.answerCbQuery('Not authorized.');
  }
  if (!session.mint) {
    return ctx.answerCbQuery('Set the mint address first!');
  }
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

  while (running && !isShuttingDown) {
    try {
      const count = multiBuyMode ? session.multiBuys : 1;
      for (let i = 0; i < count; i++) {
        if (!running || isShuttingDown) break;
        try {
          const tx = await buyToken(session.mint, buyAmount);
          ctx.reply(`✅ Buy Tx: https://solscan.io/tx/${tx}`);
        } catch (err) {
          ctx.reply(`❌ Buy failed: ${err.message}`);
        }
      }

      if (session.sellPct > 0 && running && !isShuttingDown) {
        try {
          const tx = await sellToken(session.mint, session.sellPct);
          ctx.reply(`✅ Sell Tx: https://solscan.io/tx/${tx}`);
        } catch (err) {
          ctx.reply(`❌ Sell failed: ${err.message}`);
        }
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

// === ENHANCED ERROR HANDLING ===

// Handle the 409 conflict error specifically
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  
  // Handle 409 Conflict (multiple bot instances)
  if (err.code === 409 || err.response?.error_code === 409) {
    console.log('❌ Bot conflict detected: Another instance is already running');
    console.log('Shutting down this instance...');
    gracefulShutdown();
    return;
  }
  
  // Handle other Telegram API errors
  if (err.response?.error_code === 429) {
    console.log('⚠️ Rate limited, slowing down...');
    return;
  }
  
  // Log other errors but continue running
  if (ctx) {
    try {
      ctx.reply(`❌ Bot error: ${err.message}`);
    } catch (replyErr) {
      console.error('Failed to send error message:', replyErr);
    }
  }
});

// Graceful shutdown function
async function gracefulShutdown() {
  if (isShuttingDown) return;
  
  isShuttingDown = true;
  running = false;
  
  console.log('🔄 Initiating graceful shutdown...');
  
  try {
    // Send shutdown notification to admin
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
  
  // Give some time for cleanup
  setTimeout(() => {
    console.log('👋 Process exiting');
    process.exit(0);
  }, 2000);
}

// --- ENHANCED LAUNCH & SHUTDOWN ---
async function startBot() {
  try {
    // Launch with enhanced options
    await bot.launch({
      dropPendingUpdates: true,  // Drop pending updates on restart
      allowedUpdates: ['message', 'callback_query']  // Only handle specific update types
    });
    
    console.log('✅ Net-Buy-Pumpet bot running!');
    
    // Send startup notification
    try {
      await bot.telegram.sendMessage(ADMIN, '🤖 Net-Buy-Pumpet deployed and running!');
    } catch (err) {
      console.error('Failed to send startup message:', err);
    }
    
  } catch (err) {
    console.error('❌ Failed to start bot:', err);
    
    // Handle specific startup errors
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

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the bot
startBot();
