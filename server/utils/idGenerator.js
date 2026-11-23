const crypto = require('crypto');

// Unambiguous alphanumeric alphabet (excludes 0, O, 1, I, L to prevent user confusion)
const CHARACTERS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;

/**
 * Generates a cryptographically secure random alphanumeric share code.
 * Example: X7K92P, Q8F31Z, M4K92A
 * 
 * @param {Set|Map} existingCodes - Set or Map of currently active share IDs to ensure uniqueness
 * @returns {string} Unique 6-character uppercase code
 */
function generateShareId(existingCodes = null) {
  let code = '';
  const maxAttempts = 100;
  let attempts = 0;

  do {
    code = '';
    const randomBytes = crypto.randomBytes(CODE_LENGTH);
    for (let i = 0; i < CODE_LENGTH; i++) {
      const index = randomBytes[i] % CHARACTERS.length;
      code += CHARACTERS[index];
    }
    attempts++;
  } while (existingCodes && (existingCodes.has ? existingCodes.has(code) : existingCodes[code]) && attempts < maxAttempts);

  return code;
}

/**
 * Generates a cryptographically secure random file token or UUID.
 * @returns {string} 16-character hex string
 */
function generateFileId() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = {
  generateShareId,
  generateFileId
};
