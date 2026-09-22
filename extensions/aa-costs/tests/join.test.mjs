import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { combineData } from '../scripts/build_report.mjs';

const aa = JSON.parse(await readFile(new URL('../data/aa/aa.json', import.meta.url), 'utf8'));
const pricing = JSON.parse(await readFile(new URL('../data/pricing/pricing.json', import.meta.url), 'utf8'));
const result = combineData(aa, pricing);

test('Каждый вариант AA имеет исходную API-строку с неизменными стоимостями', () => {
  for (const variant of aa.rows) {
    const row = result.rows.find(row => row.aa_source_id === variant.source_id && row.plan_id === 'api-aa');
    assert.ok(row, variant.source_name);
    assert.equal(row.cost_per_task_usd, variant.cost_per_task_usd);
    assert.equal(row.cost_total_usd, variant.cost_total_usd);
    assert.equal(row.rap_cost_per_task_usd, variant.cost_per_task_usd);
    assert.equal(row.rap_cost_total_usd, variant.cost_total_usd);
  }
});

test('Каждая подписка соединена со всеми effort только своей модели', () => {
  for (const plan of pricing.rows.filter(row => row.billing === 'subscription')) {
    const variants = aa.rows.filter(row => row.model === plan.model);
    const actual = result.rows.filter(row => row.plan_id === plan.plan_id && row.model_id === plan.model && row.kind === 'subscription');
    assert.equal(actual.length, variants.length, plan.id);
    for (const row of actual) {
      const source = variants.find(variant => variant.source_id === row.aa_source_id);
      assert.ok(source);
      assert.equal(row.intelligence_index, source.intelligence_index);
      if (source.cost_per_task_usd == null) assert.equal(row.cost_per_task_usd, null);
      else assert.ok(Math.abs(row.cost_per_task_usd / source.cost_per_task_usd - row.real_price_usd_per_million / row.api_price_usd_per_million) < 1e-9);
      if (source.cost_total_usd == null) assert.equal(row.cost_total_usd, null);
      else assert.ok(Math.abs(row.cost_total_usd / source.cost_total_usd - row.multiplier) < 1e-9);
    }
  }
});

test('RAP-сценарий буквально сохраняет отношение цен исходного проекта', () => {
  for (const row of result.rows.filter(row => row.kind === 'subscription')) {
    const plan = pricing.rows.find(plan => plan.model === row.model_id && plan.plan_id === row.plan_id);
    assert.ok(Math.abs(row.rap_multiplier - plan.coefficient) < 1e-10);
  }
});

test('Расхождения API-базы явно отмечены и не меняют исходные API-стоимости AA', () => {
  const mismatches = [...new Set(result.rows.filter(row => row.api_price_mismatch).map(row => row.model_id))].sort();
  assert.deepEqual(mismatches, ['glm-5.3-flash','mimo-v2.5-pro']);
  for (const row of result.rows.filter(row => row.plan_id === 'api-aa')) {
    assert.equal(row.multiplier, 1);
    assert.equal(row.rap_multiplier, 1);
  }
});

test('Пробелы данных и отсутствие подписок сохраняются в отчёте', () => {
  for (const model of ['grok-4.7','mimo-v2.6-pro']) {
    assert.ok(result.rows.some(row => row.model_id === model && row.plan_id === 'api-aa'));
    assert.ok(!result.rows.some(row => row.model_id === model && row.kind === 'subscription'));
    assert.match(result.coverage.find(row => row.model_id === model).details, /нет подписок/);
  }
  assert.equal(result.skipped.length, 0);
  assert.equal(new Set(result.rows.map(row => row.id)).size, result.rows.length);
});
