const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const JupiterService = require('./jupiterService');
const logger = require('../utils/logger');

class TradingEngine {
  constructor() {
    this.connection = null;
    this.wallet = null;
    this.jupiterService = null;
    this.activeStrategy = null;
    this.isRunning = false;
    this.statistics = {
      totalTrades: 0,
      totalVolume: 0,
      feesSpent: 0,
      startTime: null
    };
  }

  async initialize() {
    try {
      // Initialize Solana connection
      const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
      this.connection = new Connection(rpcUrl, 'confirmed');
      
      // Load wallet from private key
      const privateKey = JSON.parse(process.env.SOLANA_WALLET_PRIVATE_KEY);
      this.wallet = Keypair.fromSecretKey(new Uint8Array(privateKey));
      
      // Initialize Jupiter service
      this.jupiterService = new JupiterService(this.connection, this.wallet);
      await this.jupiterService.initialize();
      
      logger.info('Trading engine initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize trading engine:', error);
      throw error;
    }
  }

  async startVolumeBoostStrategy(params) {
    if (this.isRunning) {
      throw new Error('A strategy is already running');
    }

    this.isRunning = true;
    this.statistics.startTime = new Date().toISOString();
    
    const endTime = Date.now() + (params.durationMinutes * 60 * 1000);
    let tradeCount = 0;

    const strategy = {
      params,
      startTime: new Date(),
      trades: [],
      stop: async () => {
        this.isRunning = false;
        clearInterval(tradeInterval);
        logger.info('Volume boost strategy stopped');
      }
    };

    const tradeInterval = setInterval(async () => {
      if (!this.isRunning || Date.now() > endTime) {
        clearInterval(tradeInterval);
        this.isRunning = false;
        logger.info('Volume boost strategy completed');
        return;
      }

      try {
        // Execute buy trade
        const buyResult = await this.executeTrade(
          'So11111111111111111111111111111111111111112', // SOL mint
          params.tokenAddress,
          params.solAmount * 0.4, // 40% of allocated amount
          params.slippageBps
        );

        if (buyResult) {
          tradeCount++;
          this.statistics.totalTrades++;
          this.statistics.totalVolume += params.solAmount * 0.4;
          this.statistics.feesSpent += buyResult.fee;

          strategy.trades.push({
            type: 'buy',
            txId: buyResult.txId,
            amount: params.solAmount * 0.4,
            timestamp: new Date()
          });

          // Wait a bit before selling
          await this.delay(5000);

          // Execute sell trade (sell all tokens we just bought)
          const sellResult = await this.executeTrade(
            params.tokenAddress,
            'So11111111111111111111111111111111111111112',
            buyResult.outputAmount, // Sell all tokens we received
            params.slippageBps * 2 // Higher slippage for sells
          );

          if (sellResult) {
            tradeCount++;
            this.statistics.totalTrades++;
            this.statistics.totalVolume += sellResult.inputAmount;
            this.statistics.feesSpent += sellResult.fee;

            strategy.trades.push({
              type: 'sell',
              txId: sellResult.txId,
              amount: sellResult.inputAmount,
              timestamp: new Date()
            });

            logger.info(`Completed trade pair ${tradeCount}/?`);
          }
        }
      } catch (error) {
        logger.error('Trade execution error:', error);
      }
    }, params.tradeIntervalSecs * 1000);

    this.activeStrategy = strategy;
    return strategy;
  }

  async executeTrade(inputMint, outputMint, amount, slippageBps) {
    try {
      const trade = await this.jupiterService.getBestRoute(
        inputMint,
        outputMint,
        amount,
        slippageBps
      );

      if (!trade) {
        throw new Error('No trade route found');
      }

      const { transaction } = await this.jupiterService.executeTrade(trade);
      const txId = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      });

      // Wait for confirmation
      const confirmation = await this.connection.confirmTransaction(txId, 'confirmed');
      
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`);
      }

      logger.info(`Trade executed successfully: ${txId}`);
      
      return {
        txId,
        inputAmount: amount,
        outputAmount: trade.outAmount,
        fee: trade.fee
      };
    } catch (error) {
      logger.error('Trade execution failed:', error);
      throw error;
    }
  }

  async stopStrategy() {
    if (this.activeStrategy && this.activeStrategy.stop) {
      await this.activeStrategy.stop();
    }
    this.isRunning = false;
    this.activeStrategy = null;
  }

  async getWalletBalance() {
    try {
      const balance = await this.connection.getBalance(this.wallet.publicKey);
      return balance / 1e9; // Convert lamports to SOL
    } catch (error) {
      logger.error('Error getting wallet balance:', error);
      throw error;
    }
  }

  getStatistics() {
    return {
      ...this.statistics,
      solBalance: this.getWalletBalance() // This will be a promise, handled in the main class
    };
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = TradingEngine;
