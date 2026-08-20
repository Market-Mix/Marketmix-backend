const assert = require('assert');
const { calculateDebtRecovery } = require('../services/sellerDebtRecoveryService');

const cases = [
  {
    name: 'recovers full debt from release amount',
    input: { releaseAmount: 120, remainingDebt: 120 },
    expected: { recoveredAmount: 120, remainingDebt: 0, isSettled: true, remainingToRecover: 0 }
  },
  {
    name: 'recovers partial debt when release is smaller',
    input: { releaseAmount: 75, remainingDebt: 120 },
    expected: { recoveredAmount: 75, remainingDebt: 45, isSettled: false, remainingToRecover: 0 }
  },
  {
    name: 'does not recover when there is no debt',
    input: { releaseAmount: 50, remainingDebt: 0 },
    expected: { recoveredAmount: 0, remainingDebt: 0, isSettled: true, remainingToRecover: 50 }
  }
];

for (const testCase of cases) {
  const result = calculateDebtRecovery(testCase.input);
  assert.deepStrictEqual(result, testCase.expected, testCase.name);
}

console.log('seller debt recovery tests passed');
