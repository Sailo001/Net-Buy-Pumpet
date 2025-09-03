// src/utils.js

// 📝 Utility functions (stubbed)
// In production, you might add DB or Redis for persistent storage

let userSessions = new Map();
let userSteps = new Map();

// ✅ Simulate showing current config
export function showCurrentConfig() {
  return (
    "📊 **Current Config (Stub)**\n" +
    "🎯 Token: FAKE1234...\n" +
    "💰 Buy: 1 SOL per cycle\n" +
    "📈 Sell: 50% per cycle\n" +
    "⏱️ Delay: 30s between cycles"
  );
}

// ✅ Store/retrieve user session
export function getUserData(userId) {
  return userSessions.get(userId) || {};
}
export function clearUserSetup(userId) {
  userSessions.delete(userId);
}

// ✅ Simulate step-by-step setup
export function getCurrentStep(userId) {
  return userSteps.get(userId) || null;
}
export function setCurrentStep(userId, step) {
  userSteps.set(userId, step);
}
