import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAaData } from './build-aa-data.mjs';
import { estimateVariant } from '../../extensions/aa-costs/scripts/estimate_api_price.mjs';

const read = async path => JSON.parse(await readFile(new URL(`../../extensions/aa-costs/data/${path}`, import.meta.url), 'utf8'));
const [aa, pricing, rates, audit, weighting] = await Promise.all([
  read('aa/aa.json'), read('pricing/pricing.json'), read('pricing/quota-rates.json'),
  read('pricing/quota-evidence.json'), read('aa/task-weighting.json'),
]);
const reference = createAaData(aa, pricing, rates, audit, weighting);

for (const [name, mixture] of [['без смеси RAP', undefined], ['с неверной смесью RAP', { cache: -4, input: 20, output: 'неизвестно' }]]) {
  test(`Новая сборка ${name} сохраняет квоты и инверсию AA`, () => {
    const changed = structuredClone(pricing);
    if (mixture === undefined) delete changed.standard_token_mix;
    else changed.standard_token_mix = mixture;
    const actual = createAaData(aa, changed, rates, audit, weighting);
    assert.equal(actual.quota_scenario.metadata.status, 'ok');
    assert.equal(actual.quota_scenario.metadata.included_plans, 36);
    assert.deepEqual(actual.quota_scenario, reference.quota_scenario);
    assert.deepEqual(actual.api_estimate, reference.api_estimate);
    assert.deepEqual(actual.token_scenario, reference.token_scenario);
  });
}

test('Каждый разбор сохраняет точный source_id, effort и пять исходных категорий', () => {
  assert.equal(reference.api_estimate.rows.length, aa.rows.length);
  for (const variant of aa.rows) {
    const row = reference.api_estimate.rows.find(item => item.source_id === variant.source_id);
    assert.ok(row);
    assert.equal(row.model_id, variant.model);
    assert.equal(row.model, variant.model_display);
    assert.equal(row.effort, variant.effort);
    const expected = estimateVariant(variant);
    for (const scope of ['task', 'suite']) {
      assert.deepEqual(row[scope].component_tokens, expected[scope].component_tokens);
      assert.deepEqual(row[scope].component_costs_usd, expected[scope].component_costs_usd);
      assert.deepEqual(row[scope].rates_usd_per_million, expected[scope].rates_usd_per_million);
    }
  }
});

test('Несовпадающий снимок весов исключается, а ошибка нового расчёта не скрывается', () => {
  const changed = structuredClone(weighting);
  changed.metadata.source_snapshot_retrieved_at = 'другой снимок';
  assert.equal(createAaData(aa, pricing, rates, audit, changed).aa_task_weighting, null);
  assert.deepEqual(reference.aa_task_weighting, weighting);
  const invalidAa = structuredClone(aa);
  invalidAa.rows.push(structuredClone(aa.rows[0]));
  assert.throws(() => createAaData(invalidAa, pricing, rates, audit, weighting));
});
