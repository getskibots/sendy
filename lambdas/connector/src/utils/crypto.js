// AES-256-GCM envelope encryption for token storage
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

export function encrypt(plaintext) {
  if (typeof plaintext !== 'string') throw new TypeError('encrypt() requires a string');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, config.encryption.masterKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decrypt(packed) {
  if (typeof packed !== 'string' || !packed.startsWith('v1.')) {
    throw new Error('decrypt(): not a v1 envelope');
  }
  const [, ivB64, tagB64, ctB64] = packed.split('.');
  const iv  = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct  = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_LEN)   throw new Error('decrypt(): bad IV length');
  if (tag.length !== TAG_LEN) throw new Error('decrypt(): bad tag length');
  const decipher = createDecipheriv(ALGO, config.encryption.masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}
