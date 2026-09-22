import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCost, scaleCosts, tasksForBudget } from './calculate.mjs';
import { estimateApiPrices } from './estimate_api_price.mjs';
import { buildTokenScenario } from './token_scenario.mjs';
import { buildQuotaScenario } from './quota_scenario.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const modelNotes = {
  'gemini-3.8-flash': 'Запрос Gemini 3.8 сопоставлен с опубликованной моделью Flash.',
  'deepseek-v4.1-flash': 'Запрос DeepSeek 4.1 сопоставлен с опубликованной моделью Flash.',
  'deepseek-v4-flash': 'Версия 0731 подтверждена в обоих источниках.',
};

/** Объединяет только точные согласованные model ID. */
export function combineData(aa, pricing) {
  const rows = [];
  const skipped = [];
  const plans = pricing.rows;
  const mix = pricing.standard_token_mix;
  if (!mix || Math.abs(mix.cache + mix.input + mix.output - 1) > 1e-10) throw new Error('Неверная смесь токенов Real API Pricing.');
  if (!Array.isArray(aa.rows) || !Array.isArray(plans)) throw new Error('Неверная схема снимка данных.');
  const sourceIds = new Set();
  for (const variant of aa.rows) {
    if (sourceIds.has(variant.source_id)) throw new Error(`Повтор AA source_id: ${variant.source_id}`);
    sourceIds.add(variant.source_id);
    const matches = plans.filter(plan => plan.model === variant.model);
    const baseline = matches.find(plan => isCost(plan.api_price_usd_per_million) && plan.api_price_usd_per_million > 0);
    const aaPrice = mix.cache * variant.api_price_cache_hit_usd_per_million
      + mix.input * variant.api_price_input_usd_per_million
      + mix.output * variant.api_price_output_usd_per_million;
    if (!isCost(aaPrice) || aaPrice <= 0) throw new Error(`Нет положительной API-базы AA: ${variant.source_id}`);
    const rapPrice = baseline?.api_price_usd_per_million ?? aaPrice;
    const baselineOrigin = baseline?.api_baseline_kind ?? 'aa_prices_rap_mix';
    const baselineSourceUrl = baseline?.api_source_url ?? variant.source;
    const mismatch = Math.abs(rapPrice / aaPrice - 1) > 1e-8;
    const aaNotes = [modelNotes[variant.model]];
    if (baselineOrigin === 'aa_prices_rap_mix') aaNotes.push('API-база в RAP отсутствует; рассчитана из ставок AA по смеси RAP.');
    if (mismatch) aaNotes.push(`Смешанная API-цена различается: AA $${aaPrice.toPrecision(8)}/MTok; RAP $${rapPrice.toPrecision(8)}/MTok. Выбранная API-база меняет коэффициент пересчёта.`);
    if (variant.intelligence_index_estimated) aaNotes.push('Intelligence Index помечен AA как оценочный.');
    if (variant.source_name?.includes('Fallback') || variant.quality_flags?.some(flag => /fallback/i.test(flag))) {
      aaNotes.push('AA: конфигурация Default Fallback; это часть исходного варианта модели.');
    }
    if (!isCost(variant.cost_per_task_usd) || !isCost(variant.cost_total_usd)) aaNotes.push('AA не опубликовал обе стоимости для этого effort.');
    const common = {
      model: variant.model_display,
      model_id: variant.model,
      model_provider: matches.find(plan=>plan.model_provider)?.model_provider ?? 'Не указан',
      effort: variant.effort,
      effort_label: variant.effort_label,
      effort_level: variant.effort_level,
      aa_source_id: variant.source_id,
      aa_source_name: variant.source_name,
      aa_source: variant.source,
      intelligence_index: variant.intelligence_index,
      estimated: variant.intelligence_index_estimated,
      aa_cost_per_task_usd: variant.cost_per_task_usd,
      aa_cost_total_usd: variant.cost_total_usd,
      aa_version: variant.source_version,
      api_price_mismatch: mismatch,
      rap_api_price_usd_per_million: rapPrice,
      api_baseline_origin: baselineOrigin,
      api_baseline_source_url: baselineSourceUrl,
      aa_api_price_components: {
        cache: variant.api_price_cache_hit_usd_per_million,
        input: variant.api_price_input_usd_per_million,
        output: variant.api_price_output_usd_per_million,
      },
      api_token_mix: {...mix},
    };
    rows.push({
      ...common,
      id: `${variant.source_id}::api-aa`,
      plan: 'API · исходная стоимость AA',
      plan_id: 'api-aa',
      kind: 'api',
      access_channel: 'API',
      quota_confidence: 'not_applicable',
      monthly_usd: null,
      real_price_usd_per_million: aaPrice,
      api_price_usd_per_million: aaPrice,
      multiplier: 1,
      discount_factor: 1,
      cost_per_task_usd: variant.cost_per_task_usd,
      cost_total_usd: variant.cost_total_usd,
      rap_cost_per_task_usd: variant.cost_per_task_usd,
      rap_cost_total_usd: variant.cost_total_usd,
      rap_multiplier: 1,
      rap_discount_factor: 1,
      rap_real_price_usd_per_million: rapPrice,
      pricing_source: variant.source,
      confidence: 'Исходные данные AA',
      notes: aaNotes.filter(Boolean).join(' '),
      is_estimate: false,
    });
    for (const plan of matches) {
      const subscription = plan.billing === 'subscription';
      if (plan.is_api_baseline) continue;
      if (!isCost(plan.real_price_usd_per_million) || !(plan.api_price_usd_per_million > 0)) {
        skipped.push({model:variant.model, plan:plan.plan, effort:variant.effort, reason:'Нет известной цены тарифа или положительной API-цены.'});
        continue;
      }
      const derived = scaleCosts(variant, plan.real_price_usd_per_million, aaPrice);
      const rapDerived = scaleCosts(variant, plan.real_price_usd_per_million, plan.api_price_usd_per_million);
      const extraNotes = [
        ...aaNotes,
        subscription ? 'Сценарный пересчёт при полном использовании квоты. Доступность effort в подписке отдельно не проверена.' : 'Сценарный пересчёт для альтернативного API-тарифа.',
        plan.baseline_note,
        ...(plan.warnings ?? []),
      ];
      if (plan.api_baseline_kind === 'aa_prices_rap_mix' && baselineOrigin !== 'aa_prices_rap_mix') {
        extraNotes.push('API-база в RAP отсутствует; рассчитана из ставок AA по смеси RAP.');
      }
      rows.push({
        ...common,
        ...derived,
        rap_cost_per_task_usd: rapDerived.cost_per_task_usd,
        rap_cost_total_usd: rapDerived.cost_total_usd,
        rap_multiplier: rapDerived.multiplier,
        rap_discount_factor: rapDerived.discount_factor,
        rap_real_price_usd_per_million: plan.real_price_usd_per_million,
        id: `${variant.source_id}::${plan.id ?? plan.plan_id}`,
        plan: plan.plan,
        plan_id: plan.plan_id,
        kind: subscription ? 'subscription' : 'api',
        access_channel: plan.access_channel ?? (subscription ? 'Не указан' : 'API'),
        quota_confidence: subscription ? (['high','medium','low'].includes(plan.confidence) ? plan.confidence : 'unknown') : 'not_applicable',
        monthly_usd: plan.monthly_usd,
        monthly_tokens: plan.monthly_tokens,
        real_price_usd_per_million: plan.real_price_usd_per_million,
        api_price_usd_per_million: aaPrice,
        pricing_source: plan.source_url ?? (typeof plan.source === 'string' && /^https?:/.test(plan.source) ? plan.source : 'https://github.com/FeiZhuLulu/real-api-pricing'),
        api_baseline_source: variant.source,
        rap_api_baseline_source: plan.api_source_url,
        api_baseline_origin: plan.api_baseline_kind ?? baselineOrigin,
        api_baseline_source_url: plan.api_source_url ?? baselineSourceUrl,
        confidence: plan.confidence,
        notes: extraNotes.filter(Boolean).join(' '),
        pricing_note_original: plan.note,
        pricing_quality_flags: plan.quality_flags ?? [],
        is_estimate: true,
      });
    }
  }
  const ids = rows.map(row => row.id);
  if (new Set(ids).size !== ids.length) throw new Error('Идентификаторы строк отчёта повторяются.');
  const coverage = aa.coverage.map(item => {
    const modelPlans = plans.filter(plan => plan.model === item.model && plan.billing === 'subscription');
    const count = rows.filter(row => row.model_id === item.model && row.kind === 'subscription').length;
    const gaps = [];
    if (!modelPlans.length) gaps.push('В снимке Real API Pricing нет подписок для этой модели; показан API.');
    if (item.missing_cost_variants.length) gaps.push(`AA не публикует цены: ${item.missing_cost_variants.join(', ')}.`);
    return {
      requested: item.model_display,
      model_id: item.model,
      status: gaps.length ? 'Есть пробелы' : 'Данные найдены',
      details: `${item.available_variants} вариантов AA; ${item.variants_with_both_costs} с обеими ценами; ${modelPlans.length} тарифов подписки; ${count} сочетаний подписки и effort. ${gaps.join(' ')} ${modelNotes[item.model] ?? ''}`.trim(),
    };
  });
  return { rows, coverage, skipped };
}

function csvValue(value) {
  if (value == null) return '';
  const raw = String(value);
  const safe = typeof value === 'string' && /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export async function build() {
  const aa = JSON.parse(await readFile(new URL('../data/aa/aa.json', import.meta.url), 'utf8'));
  const pricing = JSON.parse(await readFile(new URL('../data/pricing/pricing.json', import.meta.url), 'utf8'));
  const taskWeighting = JSON.parse(await readFile(new URL('../data/aa/task-weighting.json', import.meta.url), 'utf8'));
  const quotaAudit = await readFile(new URL('../data/pricing/quota-evidence.json', import.meta.url), 'utf8')
    .then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const quotaRates = await readFile(new URL('../data/pricing/quota-rates.json', import.meta.url), 'utf8')
    .then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const combined = combineData(aa, pricing);
  const { rows: pricingRows, ...pricingMetadata } = pricing;
  const report = {
    metadata: {
      generated_at: new Date().toISOString(),
      aa_version: aa.metadata.intelligence_index_version,
      aa_retrieved_at: aa.metadata.retrieved_at,
      pricing_metadata: pricingMetadata,
      default_api_baseline: 'aa',
      methodology: 'Стоимость AA × (цена тарифа за 1 млн токенов / смешанная API-цена этой модели за 1 млн токенов). По умолчанию API-база согласована со ставками AA; доступно исходное отношение цен RAP. Подписки: оценка при использовании полной квоты; один коэффициент для всех effort модели.',
      model_count: new Set(combined.rows.map(row => row.model_id)).size,
      variant_count: aa.rows.length,
      row_count: combined.rows.length,
      cost_row_count: combined.rows.filter(row => isCost(row.cost_per_task_usd) && isCost(row.cost_total_usd)).length,
    },
    ...combined,
    api_estimate: estimateApiPrices(aa, pricing),
    token_scenario: buildTokenScenario(aa, pricing, quotaAudit),
    quota_scenario: buildQuotaScenario(aa, pricing, quotaRates),
    aa_task_weighting: taskWeighting.metadata.version === aa.metadata.intelligence_index_version && taskWeighting.metadata.source_snapshot_retrieved_at === aa.metadata.retrieved_at ? taskWeighting : null,
    sources: [
      {name:'Artificial Analysis · Intelligence Index', url:aa.metadata.source_url, date:aa.metadata.retrieved_at},
      {name:'Методология AA', url:aa.metadata.methodology_url},
      {name:'Real API Pricing', url:`https://github.com/FeiZhuLulu/real-api-pricing/tree/${pricing.revision}`, date:pricing.retrieved_at_utc},
      {name:'Смесь токенов Real API Pricing', url:'https://github.com/FeiZhuLulu/real-api-pricing/blob/main/data/conventions.json'},
    ],
  };
  const template = await readFile(new URL('../templates/report.html', import.meta.url), 'utf8');
  if (template.split('__REPORT_DATA__').length !== 2) throw new Error('В шаблоне должен быть ровно один маркер данных.');
  const json = JSON.stringify(report).replaceAll('<', '\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
  await mkdir(new URL('../output/', import.meta.url), {recursive:true});
  await writeFile(new URL('../output/report.html', import.meta.url), template.replace('__REPORT_DATA__', json));
  await writeFile(new URL('../output/comparison.json', import.meta.url), JSON.stringify(report, null, 2));
  await writeFile(new URL('../output/api-price-estimates.json', import.meta.url), JSON.stringify(report.api_estimate, null, 2));
  await writeFile(new URL('../output/token-scenario.json', import.meta.url), JSON.stringify(report.token_scenario, null, 2));
  await writeFile(new URL('../output/quota-scenario.json', import.meta.url), JSON.stringify(report.quota_scenario, null, 2));
  const tokenColumns = ['model','effort','plan','kind','monthly_usd','monthly_tokens','subscription_price_usd_per_million','confidence','evidence_method','transfer_status',
    ...['task','suite'].flatMap(scope => ['status','mixture_status','total_tokens','api_price_usd_per_million','cost_usd','multiplier','cache_read_share','non_cache_input_share','cache_write_share','input_without_cache_read_share','output_share'].map(key => `${scope}_${key}`)),
    'tasks_per_month','tasks_per_100_usd','suites_per_month','source_url','aa_source_url','notes'];
  const tokenRows = report.token_scenario.rows.map(row => ({...row,
    ...Object.fromEntries(['task','suite'].flatMap(scope => Object.entries(row[scope]).map(([key,value]) => [`${scope}_${key}`,value]))),
    tasks_per_month:row.task.tasks_per_month,tasks_per_100_usd:row.task.tasks_per_100_usd,suites_per_month:row.suite.suites_per_month,notes:row.notes.join(' '),
  }));
  await writeFile(new URL('../output/token-scenario.csv', import.meta.url), '\ufeff'+[tokenColumns,...tokenRows.map(row=>tokenColumns.map(key=>row[key]))].map(row=>row.map(csvValue).join(',')).join('\r\n'));
  const estimateColumns = ['model','effort','task_price_usd_per_million','suite_price_usd_per_million','suite_inverse_price_usd_per_million','aa_fixed_mix_price_usd_per_million','rap_price_usd_per_million','rap_independent_reference','task_total_tokens','task_output_tokens','task_reported_output_tokens','task_output_relative_error_pct','task_cache_read_share','task_non_cache_input_share','task_cache_write_share','task_input_without_cache_read_share','task_output_share','suite_total_tokens','suite_reported_total_tokens','suite_total_relative_error_pct','suite_cache_read_share','suite_non_cache_input_share','suite_cache_write_share','suite_input_without_cache_read_share','suite_output_share','task_status','suite_status','source_url'];
  const estimateRows = report.api_estimate.rows.map(row=>({
    model:row.model,effort:row.effort,
    task_price_usd_per_million:row.task.price_usd_per_million,
    suite_price_usd_per_million:row.suite.price_usd_per_million,
    suite_inverse_price_usd_per_million:row.suite.inverse_price_usd_per_million,
    aa_fixed_mix_price_usd_per_million:row.aa_fixed_mix_price_usd_per_million,
    rap_price_usd_per_million:row.rap_price_usd_per_million,
    rap_independent_reference:row.rap_independent_reference,
    task_total_tokens:row.task.total_tokens,task_output_tokens:row.task.output_tokens,
    task_reported_output_tokens:row.task.reported_output_tokens,
    task_output_relative_error_pct:row.task.output_relative_error_pct,
    task_cache_read_share:row.task.cache_read_share,
    task_non_cache_input_share:row.task.non_cache_input_share,
    task_cache_write_share:row.task.cache_write_share,
    task_input_without_cache_read_share:row.task.input_without_cache_read_share,
    task_output_share:row.task.output_share,
    suite_total_tokens:row.suite.total_tokens,suite_reported_total_tokens:row.suite.reported_total_tokens,
    suite_total_relative_error_pct:row.suite.total_relative_error_pct,
    suite_cache_read_share:row.suite.cache_read_share,
    suite_non_cache_input_share:row.suite.non_cache_input_share,
    suite_cache_write_share:row.suite.cache_write_share,
    suite_input_without_cache_read_share:row.suite.input_without_cache_read_share,
    suite_output_share:row.suite.output_share,
    task_status:row.task.status,suite_status:row.suite.status,source_url:row.source_url,
  }));
  await writeFile(new URL('../output/api-price-estimates.csv', import.meta.url), '\ufeff'+[estimateColumns,...estimateRows.map(row=>estimateColumns.map(key=>row[key]))].map(row=>row.map(csvValue).join(',')).join('\r\n'));
  const columns = ['model','model_provider','access_channel','quota_confidence','effort','plan','kind','monthly_usd','real_price_usd_per_million','api_price_usd_per_million','multiplier','discount_factor','intelligence_index','aa_cost_per_task_usd','cost_per_task_usd','tasks_per_100_usd','aa_cost_total_usd','cost_total_usd','rap_api_price_usd_per_million','rap_multiplier','rap_cost_per_task_usd','rap_cost_total_usd','api_baseline_origin','api_baseline_source_url','confidence','notes','aa_source','pricing_source'];
  const table = [columns, ...report.rows.map(row => columns.map(key => key === 'tasks_per_100_usd' ? tasksForBudget(100,row.cost_per_task_usd) : row[key]))];
  await writeFile(new URL('../output/comparison.csv', import.meta.url), '\ufeff' + table.map(row => row.map(csvValue).join(',')).join('\r\n'));
  console.log(JSON.stringify({output:`${projectRoot}output/report.html`,models:report.metadata.model_count,variants:report.metadata.variant_count,rows:report.metadata.row_count,with_cost:report.metadata.cost_row_count,skipped:report.skipped.length},null,2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await build();
