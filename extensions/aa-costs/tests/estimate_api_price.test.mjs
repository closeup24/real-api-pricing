import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { invertCosts, estimateVariant, estimateApiPrices } from '../scripts/estimate_api_price.mjs';

const rates = {non_cache_input:2,cache_read:0.2,cache_write:2.5,answer:10,reasoning:10};
const costs = {nonCacheInput:0.2,cacheRead:0.1,cacheWrite:0.25,answer:0.1,reasoning:0.4,input:0.55,output:0.5,total:1.05};

test('Непересекающиеся токены восстанавливаются без повторного суммирования input/output', () => {
  const estimate = invertCosts(costs,rates);
  assert.equal(estimate.status,'consistent');
  assert.equal(estimate.total_tokens,750000);
  assert.equal(estimate.component_tokens.cache_write,100000);
  assert.ok(Math.abs(estimate.price_usd_per_million - 1.4)<1e-12);
});

test('Три доли токенов дают единицу, а обычный вход и cache write образуют вход без cache read', () => {
  const estimate = invertCosts(costs,rates);
  assert.ok(Math.abs(estimate.cache_read_share-500000/750000)<1e-12);
  assert.ok(Math.abs(estimate.non_cache_input_share-100000/750000)<1e-12);
  assert.ok(Math.abs(estimate.cache_write_share-100000/750000)<1e-12);
  assert.ok(Math.abs(estimate.output_share-50000/750000)<1e-12);
  assert.ok(Math.abs(estimate.input_without_cache_read_share-200000/750000)<1e-12);
  assert.ok(Math.abs(estimate.input_without_cache_read_share-estimate.non_cache_input_share-estimate.cache_write_share)<1e-12);
  assert.ok(Math.abs(estimate.cache_read_share+estimate.input_without_cache_read_share+estimate.output_share-1)<1e-12);
});

test('Те же ставки и другая доля reasoning дают другую среднюю цену', () => {
  const moreReasoning = {...costs,reasoning:4,output:4.1,total:4.65};
  const a = invertCosts(costs,rates);
  const b = invertCosts(moreReasoning,rates);
  assert.equal(b.status,'consistent');
  assert.ok(b.price_usd_per_million>a.price_usd_per_million);
  assert.ok(b.output_share>a.output_share);
});

test('Нулевой расход по нулевой ставке не позволяет вывести число токенов', () => {
  const estimate = invertCosts({...costs,cacheRead:0,input:0.45,total:0.95},{...rates,cache_read:0});
  assert.equal(estimate.status,'unavailable');
  assert.equal(estimate.component_tokens.cache_read,null);
  assert.equal(estimate.price_usd_per_million,null);
  const missing = invertCosts(null,rates);
  assert.equal(missing.status,'missing');
  for (const field of ['cache_read_share','non_cache_input_share','cache_write_share','input_without_cache_read_share','output_share']) {
    assert.equal(estimate[field],null,field);
    assert.equal(missing[field],null,field);
  }
});

test('При нулевом общем числе токенов доли не вычисляются', () => {
  const zeroCosts = Object.fromEntries(Object.keys(costs).map(key=>[key,0]));
  const estimate = invertCosts(zeroCosts,rates);
  assert.equal(estimate.total_tokens,0);
  for (const field of ['cache_read_share','non_cache_input_share','cache_write_share','input_without_cache_read_share','output_share']) assert.equal(estimate[field],null,field);
});

test('Несогласованные агрегаты расходов не выдаются за полное восстановление', () => {
  const estimate = invertCosts({...costs,total:2},rates);
  assert.equal(estimate.status,'unavailable');
  assert.equal(estimate.price_usd_per_million,null);
});

const aa = JSON.parse(await readFile(new URL('../data/aa/aa.json',import.meta.url),'utf8'));
const pricing = JSON.parse(await readFile(new URL('../data/pricing/pricing.json',import.meta.url),'utf8'));
const estimates = estimateApiPrices(aa,pricing);

test('Доли задачи и полного набора нормированы отдельно для всех восстановленных вариантов', () => {
  for (const row of estimates.rows) {
    for (const scope of ['task','suite']) {
      const estimate = row[scope];
      if (!(estimate.total_tokens>0)) continue;
      const label = `${row.source_name}: ${scope}`;
      assert.ok(Math.abs(estimate.cache_read_share+estimate.input_without_cache_read_share+estimate.output_share-1)<1e-12,label);
      assert.ok(Math.abs(estimate.input_without_cache_read_share-estimate.non_cache_input_share-estimate.cache_write_share)<1e-12,label);
      assert.ok(Math.abs(estimate.input_without_cache_read_share-(estimate.component_tokens.non_cache_input+estimate.component_tokens.cache_write)/estimate.total_tokens)<1e-12,label);
    }
  }
});

test('Варианты с согласованной инверсией совпадают с опубликованными счётчиками AA', () => {
  for (const row of estimates.rows.filter(row=>row.suite.status==='consistent')) {
    assert.ok(Math.abs(row.suite.total_relative_error_pct)<1e-6,row.source_name);
    assert.ok(Math.abs(row.suite.input_relative_error_pct)<1e-6,row.source_name);
    assert.ok(Math.abs(row.suite.output_relative_error_pct)<1e-6,row.source_name);
    assert.ok(Math.abs(row.suite.inverse_price_relative_error_pct)<1e-6,row.source_name);
    assert.ok(Math.abs(row.task.output_relative_error_pct)<1e-6,row.source_name);
  }
});

test('Fable сохраняет несовпадение инверсии, прямая цена набора использует исходные токены', () => {
  const source = aa.rows.find(row=>row.model==='claude-fable-5.1'&&row.effort==='max');
  const estimate = estimateVariant(source);
  assert.equal(estimate.task.status,'approximate');
  assert.ok(Math.abs(estimate.task.output_relative_error_pct)>0.01);
  assert.ok(Math.abs(estimate.suite.total_relative_error_pct)>1);
  assert.ok(Math.abs(estimate.suite.price_usd_per_million-2.2562242894874855)<1e-12);
  assert.notEqual(estimate.suite.price_usd_per_million,estimate.suite.inverse_price_usd_per_million);
});

test('Доли приближённого Fable используют восстановленный знаменатель, а цена набора — опубликованный', () => {
  const source = aa.rows.find(row=>row.model==='claude-fable-5.1'&&row.effort==='max');
  const {task,suite} = estimateVariant(source);
  assert.equal(suite.status,'approximate');
  assert.notEqual(suite.total_tokens,suite.reported_total_tokens);
  assert.equal(suite.cache_read_share,suite.component_tokens.cache_read/suite.total_tokens);
  assert.notEqual(suite.cache_read_share,suite.component_tokens.cache_read/suite.reported_total_tokens);
  assert.equal(suite.input_without_cache_read_share,(suite.component_tokens.non_cache_input+suite.component_tokens.cache_write)/suite.total_tokens);
  assert.equal(suite.output_share,suite.output_tokens/suite.total_tokens);
  assert.ok(Math.abs(suite.cache_read_share+suite.input_without_cache_read_share+suite.output_share-1)<1e-12);
  assert.notEqual(task.input_without_cache_read_share,suite.input_without_cache_read_share);
  assert.equal(suite.price_usd_per_million,source.cost_total_usd/suite.reported_total_tokens*1e6);
});

test('Один опубликованный effort не доказывает стабильность средней цены', () => {
  const summary = estimates.summary.find(row=>row.model_id==='deepseek-v4.1-flash');
  assert.equal(summary.task_variants,1);
  assert.equal(summary.task_spread_pct,null);
});

test('Изменение справочных цен RAP не меняет оценку из AA', () => {
  const changed = structuredClone(pricing);
  for (const row of changed.rows) row.api_price_usd_per_million *= 100;
  const recalculated = estimateApiPrices(aa,changed);
  assert.deepEqual(recalculated.rows.map(row=>[row.task.price_usd_per_million,row.suite.price_usd_per_million]),estimates.rows.map(row=>[row.task.price_usd_per_million,row.suite.price_usd_per_million]));
  assert.equal(estimates.rows.find(row=>row.model_id==='gpt-6-astra').rap_independent_reference,false);
});

test('Прямая цена набора сохраняется, но неверный агрегат не считается согласованным', () => {
  const variant = structuredClone(aa.rows.find(row=>row.model==='gpt-6-astra'&&row.effort==='max'));
  variant.cost_total_usd *= 2;
  variant.cost_total_components_usd.total *= 2;
  const estimate = estimateVariant(variant);
  assert.equal(estimate.suite.status,'approximate');
  assert.equal(estimate.suite.inversion_status,'unavailable');
  assert.ok(estimate.suite.price_usd_per_million>0);
  assert.equal(estimate.suite.inverse_price_usd_per_million,null);
});

test('Неизвестный тариф в фиксированной смеси не превращается в нулевой', () => {
  const changed = structuredClone(aa);
  changed.rows[0].api_price_cache_hit_usd_per_million = null;
  const estimate = estimateApiPrices(changed,pricing).rows[0];
  assert.equal(estimate.aa_fixed_mix_price_usd_per_million,null);
  assert.equal(estimate.task.status,'unavailable');
  assert.ok(estimate.suite.price_usd_per_million>0);
});
