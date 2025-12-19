import assert from 'node:assert/strict';
import test from 'node:test';

import { createResendSignatureHeader, verifyResendSignature } from './resend';

const SECRET = 'test-secret';
const PAYLOAD = '{"event":"delivered"}';
const TIMESTAMP_SECONDS = 1_700_000_000;
const NOW_MS = TIMESTAMP_SECONDS * 1000;

test('verifyResendSignature accepts a valid signature', () => {
  const header = createResendSignatureHeader(SECRET, TIMESTAMP_SECONDS, PAYLOAD);
  const result = verifyResendSignature({
    secret: SECRET,
    signatureHeader: header,
    payload: PAYLOAD,
    toleranceSeconds: 10,
    now: NOW_MS,
  });
  assert.equal(result.ok, true);
});

test('verifyResendSignature rejects an invalid signature', () => {
  const header = createResendSignatureHeader('wrong-secret', TIMESTAMP_SECONDS, PAYLOAD);
  const result = verifyResendSignature({
    secret: SECRET,
    signatureHeader: header,
    payload: PAYLOAD,
    toleranceSeconds: 10,
    now: NOW_MS,
  });
  assert.equal(result.ok, false);
});

test('verifyResendSignature rejects an old timestamp', () => {
  const header = createResendSignatureHeader(SECRET, TIMESTAMP_SECONDS, PAYLOAD);
  const result = verifyResendSignature({
    secret: SECRET,
    signatureHeader: header,
    payload: PAYLOAD,
    toleranceSeconds: 0,
    now: NOW_MS + 60_000,
  });
  assert.equal(result.ok, false);
});
