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
  SOLANA_PRIVATE_KEY: PRIVATE_KEY,
  SOLANA_RPC_URL:     RPC_URL
} = process.env;

// Use provided RPC URL or default to Solana mainnet
const rpcEndpoint = RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(rpcEndpoint, 'confirmed');
const payer      = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const bot        = new Telegraf(TELEGRAM_TOKEN);

let running      = false;
let isShuttingDown = false;

// Session and setup state
let session = {
  mint:      '',    // SPL token mint
  buySol:    0,     // SOL per buy
  sellPct:   0,     // % to sell each round
  delaySec:  2,     // Delay between rounds
  buyScale:  1.1,   // Buy scaling factor
  multiBuys: 3      // Rounds per cycle
};

// Setup flow state
const setupFlow = {
  users: new Map(), // userId -> currentStep
  data: new Map()   // userId -> setupData
};

const SETUP_STEPS = {
  WAITING_CONTRACT: 'waiting_contract',
  WAITING_SOL_AMOUNT: 'waiting_sol_amount', 
  WAITING_SELL_PCT: 'waiting_sell_pct',
  WAITING_DELAY: 'waiting_delay',
  WAITING_MULTI_BUYS: 'waiting_multi_buys',
  CONFIRMATION: 'confirmation'
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

// === SETUP FLOW HELPERS ===

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
    `📈 **Buy Scaling:** ${session.buyScale}x`
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
    '🚀 **Available Commands:**',
    '⚙️ `/setup` - Configure pump parameters',
    '📊 `/status` - View current configuration', 
    '🔥 `/pump` - Start pumping',
    '⏹️ `/stop` - Stop pumping',
    '💰 `/sellall` - Sell all tokens',
    '',
    '💡 **Start with `/setup` to configure your pump!**'
  ].join('\n');
  
  ctx.reply(welcomeMsg, { parse_mode: 'Markdown' });
});

// New streamlined setup command
bot.command('setup', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  
  clearUserSetup(ctx.from.id);
  setUserStep(ctx.from.id, SETUP_STEPS.WAITING_CONTRACT);
  
  ctx.reply(
    '🔧 **Pump Setup - Step 1/5**\n\n' +
    '🎯 **Enter Token Contract Address:**\n' +
    '📝 Please send the contract address (mint) of the token you want to pump.\n\n' +
    '💡 Example: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`',
    { parse_mode: 'Markdown' }
  );
});

// Status command
bot.command('status', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  
  const statusMsg = [
    showCurrentConfig(),
    '',
    `🔄 **Bot Status:** ${running ? '🟢 Pumping Active' : '🔴 Stopped'}`,
    `🌐 **Connection:** ${rpcEndpoint}`,
    `👤 **Wallet:** ${payer.publicKey.toString().slice(0, 8)}...`
  ].join('\n');
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('⚙️ New Setup', 'start_setup')],
    [Markup.button.callback('💰 Sell All', 'sell_all_confirm')],
    [Markup.button.callback('🔄 Refresh', 'refresh_status')]
  ]);
  
  ctx.reply(statusMsg, { ...keyboard, parse_mode: 'Markdown' });
});

// Handle the streamlined setup flow
bot.on('text', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  
  const userId = ctx.from.id;
  const currentStep = getCurrentStep(userId);
  const text = ctx.message.text.trim();
  
  if (!currentStep) return; // Not in setup flow
  
  const userData = getUserData(userId);
  
  try {
    switch (currentStep) {
      case SETUP_STEPS.WAITING_CONTRACT:
        // Validate contract address
        if (!text || text.length < 32 || text.length > 50) {
          return ctx.reply('❌ Invalid contract address. Please enter a valid Solana token mint address.');
        }
        
        // Try to verify the token exists
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
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          return ctx.reply(`❌ Token not found in Raydium pools. Please check the contract address.\n\nError: ${err.message}`);
        }
        break;
        
      case SETUP_STEPS.WAITING_SOL_AMOUNT:
        const solAmount = parseFloat(text);
        if (isNaN(solAmount) || solAmount <= 0 || solAmount > 100) {
          return ctx.reply('❌ Invalid SOL amount. Please enter a number between 0.01 and 100.');
        }
        
        userData.buySol = solAmount;
        setUserStep(userId, SETUP_STEPS.WAITING_SELL_PCT);
        
        ctx.reply(
          '✅ **SOL Amount Set!**\n\n' +
          '🔧 **Setup - Step 3/5**\n\n' +
          '📈 **Enter Sell Percentage:**\n' +
          '📝 What % of tokens to sell after each buy cycle?\n\n' +
          '💡 Examples: `0` (no selling), `25`, `50`, `100`',
          { parse_mode: 'Markdown' }
        );
        break;
        
      case SETUP_STEPS.WAITING_SELL_PCT:
        const sellPct = parseInt(text);
        if (isNaN(sellPct) || sellPct < 0 || sellPct > 100) {
          return ctx.reply('❌ Invalid percentage. Please enter a number between 0 and 100.');
        }
        
        userData.sellPct = sellPct;
        setUserStep(userId, SETUP_STEPS.WAITING_DELAY);
        
        ctx.reply(
          '✅ **Sell Percentage Set!**\n\n' +
          '🔧 **Setup - Step 4/5**\n\n' +
          '⏱️ **Enter Delay Between Rounds:**\n' +
          '📝 How many seconds to wait between buy cycles?\n\n' +
          '💡 Examples: `1`, `5`, `10` (minimum: 1 second)',
          { parse_mode: 'Markdown' }
        );
        break;
        
      case SETUP_STEPS.WAITING_DELAY:
        const delay = parseInt(text);
        if (isNaN(delay) || delay < 1 || delay > 300) {
          return ctx.reply('❌ Invalid delay. Please enter a number between 1 and 300 seconds.');
        }
        
        userData.delaySec = delay;
        setUserStep(userId, SETUP_STEPS.WAITING_MULTI_BUYS);
        
        ctx.reply(
          '✅ **Delay Set!**\n\n' +
          '🔧 **Setup - Step 5/5**\n\n' +
          '🔄 **Enter Multi-Buys per Cycle:**\n' +
          '📝 How many buys to execute in each cycle?\n\n' +
          '💡 Examples: `1` (single buy), `3`, `5` (max: 10)',
          { parse_mode: 'Markdown' }
        );
        break;
        
      case SETUP_STEPS.WAITING_MULTI_BUYS:
        const multiBuys = parseInt(text);
        if (isNaN(multiBuys) || multiBuys < 1 || multiBuys > 10) {
          return ctx.reply('❌ Invalid number. Please enter between 1 and 10 buys per cycle.');
        }
        
        userData.multiBuys = multiBuys;
        setUserStep(userId, SETUP_STEPS.CONFIRMATION);
        
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirm & Save', 'confirm_setup')],
          [Markup.button.callback('❌ Cancel Setup', 'cancel_setup')],
          [Markup.button.callback('🔄 Start Over', 'start_setup')]
        ]);
        
        ctx.reply(
          '🎉 **Setup Complete!**\n\n' + 
          getSetupSummary(userData) + '\n\n' +
          '✅ Ready to save configuration?',
          { ...keyboard, parse_mode: 'Markdown' }
        );
        break;
    }
  } catch (err) {
    ctx.reply(`❌ Setup error: ${err.message}`);
    clearUserSetup(userId);
  }
});

// === BUTTON HANDLERS ===

bot.action('start_setup', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  
  clearUserSetup(ctx.from.id);
  setUserStep(ctx.from.id, SETUP_STEPS.WAITING_CONTRACT);
  
  ctx.editMessageText(
    '🔧 **Pump Setup - Step 1/5**\n\n' +
    '🎯 **Enter Token Contract Address:**\n' +
    '📝 Please send the contract address (mint) of the token you want to pump.\n\n' +
    '💡 Example: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`',
    { parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

bot.action('confirm_setup', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  
  const userData = getUserData(ctx.from.id);
  
  // Apply the new configuration
  session.mint = userData.mint;
  session.buySol = userData.buySol;
  session.sellPct = userData.sellPct;
  session.delaySec = userData.delaySec;
  session.multiBuys = userData.multiBuys;
  
  clearUserSetup(ctx.from.id);
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔥 Start Pump', 'start_pump')],
    [Markup.button.callback('📊 View Status', 'refresh_status')],
    [Markup.button.callback('⚙️ New Setup', 'start_setup')]
  ]);
  
  ctx.editMessageText(
    '🎉 **Configuration Saved Successfully!**\n\n' + 
    showCurrentConfig() + '\n\n' +
    '🚀 Ready to start pumping?',
    { ...keyboard, parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

bot.action('cancel_setup', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  
  clearUserSetup(ctx.from.id);
  ctx.editMessageText('❌ Setup cancelled. Use `/setup` to start again.');
  ctx.answerCbQuery();
});

bot.action('refresh_status', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  
  const statusMsg = [
    showCurrentConfig(),
    '',
    `🔄 **Bot Status:** ${running ? '🟢 Pumping Active' : '🔴 Stopped'}`,
    `🌐 **Connection:** ${rpcEndpoint}`,
    `👤 **Wallet:** ${payer.publicKey.toString().slice(0, 8)}...`
  ].join('\n');
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('⚙️ New Setup', 'start_setup')],
    [Markup.button.callback('💰 Sell All', 'sell_all_confirm')],
    [Markup.button.callback('🔄 Refresh', 'refresh_status')]
  ]);
  
  ctx.editMessageText(statusMsg, { ...keyboard, parse_mode: 'Markdown' });
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
  
  // Start the pump
  running = true;
  ctx.editMessageText('🔥 **Pump Started!**\n\nMonitoring transactions...');
  ctx.answerCbQuery();
  
  // Run the pump logic
  startPumpLoop(ctx);
});

bot.action('sell_all_confirm', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  
  if (!session.mint) {
    ctx.answerCbQuery('No token configured!');
    return;
  }
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🚨 YES, SELL ALL', 'sell_all_execute')],
    [Markup.button.callback('❌ Cancel', 'refresh_status')]
  ]);
  
  ctx.editMessageText(
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
    ctx.editMessageText('⏳ Selling all tokens...');
    const tx = await sellToken(session.mint, 100);
    ctx.editMessageText(
      '✅ **All Tokens Sold!**\n\n' +
      `📊 Transaction: [View on Solscan](https://solscan.io/tx/${tx})`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    ctx.editMessageText(`❌ **Sell Failed:**\n\n${err.message}`);
  }
  ctx.answerCbQuery();
});

// === PUMP LOGIC ===

async function startPumpLoop(ctx) {
  let buyAmount = session.buySol;
  let cycleCount = 0;

  while (running && !isShuttingDown) {
    try {
      cycleCount++;
      ctx.telegram.sendMessage(ADMIN, `🔄 **Cycle ${cycleCount} Starting**`);

      // Execute multiple buys
      for (let i = 0; i < session.multiBuys; i++) {
        if (!running || isShuttingDown) break;
        
        try {
          const tx = await buyToken(session.mint, buyAmount);
          ctx.telegram.sendMessage(ADMIN, 
            `✅ **Buy ${i + 1}/${session.multiBuys}** - ${buyAmount.toFixed(3)} SOL\n` +
            `📊 [View Transaction](https://solscan.io/tx/${tx})`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          ctx.telegram.sendMessage(ADMIN, `❌ **Buy ${i + 1} Failed:** ${err.message}`);
        }
        
        // Small delay between buys in multi-buy
        if (i < session.multiBuys - 1) {
          await new Promise(res => setTimeout(res, 1000));
        }
      }

      // Sell if configured
      if (session.sellPct > 0 && running && !isShuttingDown) {
        try {
          const tx = await sellToken(session.mint, session.sellPct);
          ctx.telegram.sendMessage(ADMIN, 
            `📈 **Sold ${session.sellPct}%** of tokens\n` +
            `📊 [View Transaction](https://solscan.io/tx/${tx})`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          ctx.telegram.sendMessage(ADMIN, `❌ **Sell Failed:** ${err.message}`);
        }
      }

      // Scale up buy amount for next cycle
      buyAmount *= session.buyScale;
      
      // Wait before next cycle
      const jitter = 0.8 + Math.random() * 0.4;
      const delayMs = Math.max(0.5, session.delaySec * jitter) * 1000;
      await new Promise(res => setTimeout(res, delayMs));
      
    } catch (e) {
      ctx.telegram.sendMessage(ADMIN, `❌ **Cycle ${cycleCount} Error:** ${e.message}`);
    }
  }

  ctx.telegram.sendMessage(ADMIN, '⏹️ **Pump Stopped**');
}

// Simple commands
bot.command('pump', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (running) return ctx.reply('⏳ Pump already in progress.');
  if (!session.mint) return ctx.reply('❌ Complete setup first! Use `/setup`');

  running = true;
  ctx.reply('🔥 **Pump Started!**', { parse_mode: 'Markdown' });
  startPumpLoop(ctx);
});

bot.command('stop', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  running = false;
  ctx.reply('⏹️ **Pump will stop after current cycle.**', { parse_mode: 'Markdown' });
});

bot.command('sellall', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (!session.mint) return ctx.reply('❌ No token configured!');
  
  try {
    const tx = await sellToken(session.mint, 100);
    ctx.reply(
      '✅ **All Tokens Sold!**\n\n' +
      `📊 [View Transaction](https://solscan.io/tx/${tx})`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    ctx.reply(`❌ **Sell Failed:** ${err.message}`);
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
      ctx.reply(`❌ Bot error: ${err.message}`);
    } catch (replyErr) {
      console.error('Failed to send error message:', replyErr);
    }
  }
});

// === HEALTH CHECK SERVER FOR RENDER ===
import { createServer } from 'http';

const port = process.env.PORT || 3000;
const server = createServer((req, res) => {
  if (res.headersSent) return;
  
  try {
    if (req.url === '/webhook' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        if (res.headersSent) return;
        try {
          const update = JSON.parse(body);
          bot.handleUpdate(update);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
        } catch (err) {
          console.error('Webhook processing error:', err);
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Bad Request');
          }
        }
      });
    } else if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'healthy', 
        bot_running: !isShuttingDown,
        pump_active: running,
        configured: !!session.mint,
        timestamp: new Date().toISOString() 
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  } catch (err) {
    console.error('Server error:', err);
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
    
    try {
      await bot.telegram.sendMessage(ADMIN, '🤖 Net-Buy-Pumpet deployed and running!');
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
