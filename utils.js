// Utility functions for backend security and validation
const profanityList = require('./profanityList');

function containsProfanity(str) {
  if (!str) return false;
  const lower = str.toLowerCase();
  return profanityList.some(word => lower.includes(word));
}

function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  // Remove leading/trailing whitespace, collapse spaces, strip non-printables
  let clean = name.trim().replace(/\s+/g, ' ').replace(/[^\x20-\x7E]/g, '');
  // Limit length
  if (clean.length > 32) clean = clean.slice(0, 32);
  // Replace profanity with asterisks
  if (containsProfanity(clean)) clean = '***';
  return clean;
}

// Simple in-memory rate limiter (per socket)
const rateLimits = {};
function rateLimit(socketId, event, maxPerSec = 4) {
  const now = Date.now();
  if (!rateLimits[socketId]) rateLimits[socketId] = {};
  if (!rateLimits[socketId][event]) rateLimits[socketId][event] = [];
  // Remove old timestamps
  rateLimits[socketId][event] = rateLimits[socketId][event].filter(ts => now - ts < 1000);
  rateLimits[socketId][event].push(now);
  if (rateLimits[socketId][event].length > maxPerSec) {
    return false; // rate limited
  }
  return true;
}

module.exports = {
  containsProfanity,
  sanitizeName,
  rateLimit,
};
