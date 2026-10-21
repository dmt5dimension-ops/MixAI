const test = require('node:test');
const assert = require('node:assert');

test('a suite de regressao roda', () => {
  assert.strictEqual(1 + 1, 2);
});
