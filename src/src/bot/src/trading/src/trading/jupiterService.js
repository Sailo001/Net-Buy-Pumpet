const axios = require('axios');
const { Connection, PublicKey, Transaction } = require('@solana/web3.js');
const logger = require('../utils/logger');

class JupiterService {
  constructor(connection, wallet) {
    this.connection = connection;
    this.wallet = wallet;
    this.baseUrl = 'https://quote-api.jup.ag/v6';
  }

  async initialize() {
    // Check if Jupiter API is available
    try {
      const response = await axios.get(`${this.baseUrl}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000`);
      logger.info('Jupiter API is accessible');
    } catch (error) {
      logger.error('Jupiter API is not accessible:', error.message);
      throw error;
    }
  }

  async getBestRoute(inputMint, outputMint, amount, slippageBps = 100) {
    try {
      const response = await axios.get(`${this.baseUrl}/quote`, {
        params: {
          inputMint,
          outputMint,
          amount: Math.floor(amount * 1e9), // Convert SOL to lamports
          slippageBps
        }
      });

      if (response.data.error) {
        throw new Error(response.data.error);
      }

      return response.data;
    } catch (error) {
      logger.error('Error getting quote from Jupiter:', error.message);
      throw error;
    }
  }

  async executeTrade(quoteResponse) {
    try {
      const response = await axios.post(`${this.baseUrl}/swap`, {
        quoteResponse,
        userPublicKey: this.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true
      });

      if (response.data.error) {
        throw new Error(response.data.error);
      }

      // Deserialize the transaction
      const transaction = Transaction.from(Buffer.from(response.data.swapTransaction, 'base64'));
      
      // Sign the transaction
      transaction.partialSign(this.wallet);

      return {
        transaction,
        swapTransaction: response.data.swapTransaction
      };
    } catch (error) {
      logger.error('Error executing trade:', error.message);
      throw error;
    }
  }
}

module.exports = JupiterService;
