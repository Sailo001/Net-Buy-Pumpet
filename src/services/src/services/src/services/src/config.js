// src/config.js

// 📝 Stub configuration
// Replace with real values or environment variables when ready

export const ADMIN = process.env.ADMIN_ID || "123456789"; // Your Telegram user ID
export const rpcEndpoint = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
export const payer = {
  publicKey: {
    toString: () => "FakePublicKey1234567890"
  }
};
