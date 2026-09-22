import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { auditMatchesPricing, buildTokenScenario, tokenMetrics } from '../scripts/token_scenario.mjs';

const aa = JSON.parse(await readFile(new URL('../data/aa/aa.json', import.meta.url), 'utf8'));
const pricing = JSON.parse(await readFile(new URL('../data/pricing/pricing.json', import.meta.url), 'utf8'));
const audit = JSON.parse(await readFile(new URL('../data/pricing/quota-evidence.json', import.meta.url), 'utf8'));
const result = buildTokenScenario(aa, pricing, audit);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12, `${actual} != ${expected}`);
const freshAudit = (data, rows) => ({metadata:{pricing_revision:data.revision,pricing_retrieved_at_utc:data.retrieved_at_utc,pricing_rows_sha256:createHash('sha256').update(JSON.stringify(data.rows)).digest('hex')},rows});

test('Отбор допускает только проверенные наблюдения; все исключения сохраняются', () => {
  assert.equal(result.metadata.audit_valid, true);
  assert.equal(result.quotas.length + result.excluded.length, pricing.rows.filter(row => row.billing === 'subscription').length);
  assert.ok(result.quotas.length > 0);
  for (const quota of result.quotas) {
    const source = pricing.rows.find(row => row.id === quota.id);
    assert.equal(source.workload, 'measured');
    assert.ok(['direct_measurement','pooled_measurements'].includes(quota.evidence_method));
    assert.ok(['high','medium'].includes(quota.confidence));
    assert.equal(quota.cross_mix_transfer_confirmed, false);
    assert.equal(quota.token_limit_kind, 'observed_workload');
  }
  for (const excluded of result.excluded) assert.ok(excluded.reason_ru.length > 0);
  assert.equal(result.coverage.official_token_caps, 0);
  assert.equal(result.coverage.confirmed_cross_mix_transfers, 0);
});

test('Синтетические и перенесённые квоты не проходят даже при ошибочном разрешении в аудите', () => {
  const synthetic = pricing.rows.find(row => row.workload === 'standard' && row.billing === 'subscription');
  const direct = pricing.rows.find(row => row.id === result.quotas[0].id);
  const subset = {...pricing, rows:[synthetic,direct]};
  const evidence = subset.rows.map((row,index) => ({id:row.id,usable_for_observed_scenario:true,evidence_method:index===0?'direct_measurement':'plan_extrapolation',token_limit_kind:'observed_workload'}));
  const filtered = buildTokenScenario(aa, subset, freshAudit(subset,evidence));
  assert.equal(filtered.quotas.length, 0);
  assert.equal(filtered.excluded.length, 2);
});

test('Изменённый снимок, отсутствующий аудит и повтор ID закрывают отбор подписок', () => {
  const modified = structuredClone(pricing);
  modified.rows[0].monthly_tokens += 1;
  assert.equal(auditMatchesPricing(modified,audit), false);
  for (const [data,evidence] of [[modified,audit],[pricing,null],[pricing,{...audit,rows:{}}],[pricing,{...audit,rows:[null]}],[pricing,{...audit,rows:[...audit.rows,audit.rows[0]]}]]) {
    const stale = buildTokenScenario(aa,data,evidence);
    assert.equal(stale.metadata.audit_valid,false);
    assert.equal(stale.quotas.length,0);
    assert.equal(stale.rows.filter(row=>row.kind==='api').length,aa.rows.length);
  }
});

test('В новом методе фиксированная смесь RAP не участвует', () => {
  const changed = {...pricing,standard_token_mix:{cache:0,input:0,output:1}};
  assert.deepEqual(buildTokenScenario(aa,changed,audit).rows,result.rows);
});

test('API-стоимости сохраняются, а каждый тариф соединяется только со своей моделью', () => {
  for (const variant of aa.rows) {
    const api = result.rows.find(row=>row.kind==='api' && row.aa_source_id===variant.source_id);
    assert.equal(api.task.cost_usd,variant.cost_per_task_usd);
    assert.equal(api.suite.cost_usd,variant.cost_total_usd);
  }
  for (const quota of result.quotas) {
    const rows = result.rows.filter(row=>row.quota_id===quota.id);
    assert.equal(rows.length,aa.rows.filter(row=>row.model===quota.model_id).length);
    assert.ok(rows.every(row=>row.model_id===quota.model_id));
    assert.equal(new Set(rows.map(row=>row.subscription_price_usd_per_million)).size,1);
  }
  assert.equal(new Set(result.rows.map(row=>row.id)).size,result.rows.length);
});

test('Токены определяют затраты и месячную ёмкость; API-отношение даёт тот же результат', () => {
  for (const row of result.rows.filter(row=>row.kind==='subscription')) {
    close(row.subscription_price_usd_per_million,row.monthly_usd/row.monthly_tokens*1e6);
    for (const scope of ['task','suite']) {
      const value = row[scope];
      if (value.total_tokens == null) {
        assert.equal(value.cost_usd,null);
        continue;
      }
      close(value.cost_usd,row.monthly_usd*value.total_tokens/row.monthly_tokens);
      close(value.cost_usd*(scope==='task'?value.tasks_per_month:value.suites_per_month),row.monthly_usd);
      if (value.api_price_usd_per_million > 0) {
        const api = result.rows.find(api=>api.kind==='api'&&api.aa_source_id===row.aa_source_id);
        close(value.cost_usd,api[scope].cost_usd*value.multiplier);
      }
    }
  }
  const astra = result.rows.filter(row=>row.kind==='subscription'&&row.model_id==='gpt-6-astra');
  assert.ok(astra.some(row=>Math.abs(row.task.multiplier-row.suite.multiplier)>1e-6));
});

test('Полный набор использует опубликованные токены, а не обратный расчёт категорий', () => {
  const quota = {monthly_usd:20,monthly_tokens:1e9};
  const estimate = {status:'approximate',total_tokens:3e6,reported_total_tokens:2e6};
  const value = tokenMetrics(estimate,10,'suite',quota);
  assert.equal(value.total_tokens,2e6);
  assert.equal(value.api_price_usd_per_million,5);
  assert.equal(value.cost_usd,.04);
  assert.equal(value.status,'consistent');
  assert.equal(value.mixture_status,'approximate');
  assert.equal(value.tasks_per_month,null);
  assert.equal(value.suites_per_month,500);
});

test('Неизвестные токены не превращаются в бесплатные задачи', () => {
  const value = tokenMetrics({status:'missing'},null,'task',{monthly_usd:20,monthly_tokens:1e9});
  assert.equal(value.total_tokens,null);
  assert.equal(value.cost_usd,null);
  assert.equal(value.tasks_per_month,null);
  assert.equal(value.tasks_per_100_usd,null);
  assert.equal(value.multiplier,null);
});

test('Отвергнутая инверсия задачи не возвращается как приближённая цена подписки', () => {
  const value = tokenMetrics({status:'unavailable',total_tokens:750000},2,'task',{monthly_usd:20,monthly_tokens:1e9});
  assert.equal(value.total_tokens,null);
  assert.equal(value.api_price_usd_per_million,null);
  assert.equal(value.cost_usd,null);
  assert.equal(value.tasks_per_month,null);
  assert.equal(value.status,'missing');
});
