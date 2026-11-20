const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../config/db');

test('transaction preserves the original error if rollback fails and releases the client', async () => {
  const originalConnect = db.pool.connect;
  const originalError = new Error('callback failed');
  const calls = [];
  let released = false;

  db.pool.connect = async () => ({
    query: async (sql) => {
      calls.push(sql);
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
    },
    release: () => { released = true; }
  });

  try {
    await assert.rejects(
      db.transaction(async () => { throw originalError; }),
      (error) => error === originalError
    );
    assert.deepEqual(calls, ['BEGIN', 'ROLLBACK']);
    assert.equal(released, true);
  } finally {
    db.pool.connect = originalConnect;
  }
});

test('transaction rolls back a failed commit and releases the client', async () => {
  const originalConnect = db.pool.connect;
  const commitError = new Error('commit failed');
  const calls = [];
  let released = false;

  db.pool.connect = async () => ({
    query: async (sql) => {
      calls.push(sql);
      if (sql === 'COMMIT') throw commitError;
    },
    release: () => { released = true; }
  });

  try {
    await assert.rejects(
      db.transaction(async () => 'done'),
      (error) => error === commitError
    );
    assert.deepEqual(calls, ['BEGIN', 'COMMIT', 'ROLLBACK']);
    assert.equal(released, true);
  } finally {
    db.pool.connect = originalConnect;
  }
});
