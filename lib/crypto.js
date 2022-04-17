const sodium = require('sodium-universal')
const b4a = require('b4a')
const crypto = require('@backbonedao/crypto')

function hash (data) {
  // const out = b4a.allocUnsafe(32)
  // sodium.crypto_generichash(out, data)
  // return out
  return crypto.createHash(data)
}

function createKeyPair (seed) {
  // const publicKey = b4a.alloc(32)
  // const secretKey = b4a.alloc(64)
  // if (seed) sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  // else sodium.crypto_sign_keypair(publicKey, secretKey)
  // return { publicKey, secretKey }
  return crypto.keyPair(seed)
}

module.exports = {
  hash,
  createKeyPair
}
