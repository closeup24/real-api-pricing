import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleCosts, tasksForBudget, relativeEfficiency } from '../scripts/calculate.mjs';

test('Коэффициент подписки применяется к обеим метрикам одинаково', () => {
  const result = scaleCosts({ cost_per_task_usd: 5.86, cost_total_usd: 7275 }, 0.01274, 0.68);
  assert.ok(Math.abs(result.cost_per_task_usd - 0.10978882352941176) < 1e-12);
  assert.ok(Math.abs(result.cost_total_usd - 136.29926470588234) < 1e-9);
  assert.ok(Math.abs(result.discount_factor - 53.37519623233909) < 1e-9);
});

test('API с коэффициентом 1 сохраняет исходные стоимости', () => {
  const aa = { cost_per_task_usd: 7.629706364004841, cost_total_usd: 13128.859210511622 };
  const result = scaleCosts(aa, 0.63375, 0.63375);
  assert.equal(result.cost_per_task_usd, aa.cost_per_task_usd);
  assert.equal(result.cost_total_usd, aa.cost_total_usd);
});

test('Отсутствующее значение не превращается в нулевую цену', () => {
  const result = scaleCosts({ cost_per_task_usd: null, cost_total_usd: 100 }, 0.01, 0.5);
  assert.equal(result.cost_per_task_usd, null);
  assert.equal(result.cost_total_usd, 2);
  assert.equal(tasksForBudget(100, null), null);
  assert.equal(tasksForBudget(100, 0), null);
});

test('Нельзя делить на отсутствующую или нулевую API-цену', () => {
  for (const baseline of [0, null, undefined, -1, NaN, Infinity]) {
    assert.throws(() => scaleCosts({}, 0.1, baseline), RangeError);
  }
});

test('Пересчёт дороже API допустим, нормировка учитывает меньший объём работы', () => {
  const result = scaleCosts({ cost_per_task_usd: 2, cost_total_usd: 200 }, 1, 0.5);
  assert.equal(result.cost_per_task_usd, 4);
  assert.equal(result.discount_factor, 0.5);
  assert.equal(tasksForBudget(100, 4), 25);
  assert.equal(relativeEfficiency(4, [null, 0, 2, 4]), 50);
});
