import { createHash } from 'node:crypto';
import { isCost, tasksForBudget } from './calculate.mjs';
import { estimateVariant } from './estimate_api_price.mjs';

const positive = value => isCost(value) && value > 0;
const ALLOWED_METHODS = new Set(['direct_measurement', 'pooled_measurements']);
const SHARES = ['cache_read_share', 'non_cache_input_share', 'cache_write_share', 'input_without_cache_read_share', 'output_share'];
const ASSUMPTION = 'Условный перенос измеренной месячной ёмкости на нагрузку AA. Независимость квоты от состава токенов и effort не подтверждена; это не гарантированный лимит подписки.';

/** Отбор действует только для того снимка тарифов, который был проверен вручную. */
export function auditMatchesPricing(pricing, audit) {
  const metadata = audit?.metadata;
  if (!metadata || !Array.isArray(audit.rows)) return false;
  if (!audit.rows.every(row => row && typeof row.id === 'string')) return false;
  const fingerprint = createHash('sha256').update(JSON.stringify(pricing.rows)).digest('hex');
  return metadata.pricing_revision === pricing.revision
    && metadata.pricing_retrieved_at_utc === pricing.retrieved_at_utc
    && metadata.pricing_rows_sha256 === fingerprint
    && new Set(audit.rows.map(row => row.id)).size === audit.rows.length;
}

/** Цена подписки относится ко всему объёму; AA задаёт число токенов на единицу работы. */
export function tokenMetrics(estimate, originalCost, scope, quota = null) {
  const tokens = scope === 'suite' ? estimate.reported_total_tokens
    : ['consistent','approximate'].includes(estimate.status) ? estimate.total_tokens : null;
  const totalTokens = positive(tokens) ? tokens : null;
  const apiPrice = isCost(originalCost) && totalTokens != null ? originalCost / totalTokens * 1e6 : null;
  const subscriptionPrice = quota && positive(quota.monthly_tokens) && positive(quota.monthly_usd)
    ? quota.monthly_usd / quota.monthly_tokens * 1e6 : null;
  const cost = quota
    ? subscriptionPrice != null && totalTokens != null ? quota.monthly_usd * totalTokens / quota.monthly_tokens : null
    : isCost(originalCost) ? originalCost : null;
  const unitsPerMonth = quota && totalTokens != null && positive(quota.monthly_tokens) ? quota.monthly_tokens / totalTokens : null;
  const status = cost == null || totalTokens == null ? 'missing'
    : scope === 'task' && estimate.status !== 'consistent' ? 'approximate' : 'consistent';
  return {
    status,
    mixture_status: estimate.status ?? 'missing',
    tokens_method: scope === 'suite' ? 'published_total' : 'cost_inversion',
    total_tokens: totalTokens,
    api_price_usd_per_million: apiPrice,
    cost_usd: cost,
    multiplier: quota ? positive(apiPrice) && subscriptionPrice != null ? subscriptionPrice / apiPrice : null : 1,
    tasks_per_month: scope === 'task' ? unitsPerMonth : null,
    suites_per_month: scope === 'suite' ? unitsPerMonth : null,
    tasks_per_100_usd: scope === 'task' ? tasksForBudget(100, cost) : null,
    suites_per_100_usd: scope === 'suite' ? tasksForBudget(100, cost) : null,
    ...Object.fromEntries(SHARES.map(key => [key, isCost(estimate[key]) ? estimate[key] : null])),
    notes: estimate.notes ?? [],
  };
}

/** Не использует фиксированную смесь, готовую цену токена или API-базу RAP. */
export function buildTokenScenario(aa, pricing, audit) {
  const auditValid = auditMatchesPricing(pricing, audit);
  const evidenceRows = Array.isArray(audit?.rows) ? audit.rows.filter(row => row && typeof row.id === 'string') : [];
  const evidenceById = new Map(evidenceRows.map(row => [row.id, row]));
  const quotas = [];
  const excluded = [];
  for (const plan of pricing.rows.filter(row => row.billing === 'subscription')) {
    const evidence = evidenceById.get(plan.id);
    const reasons = [];
    if (!auditValid) reasons.push('Аудит происхождения квот отсутствует или устарел для этого снимка.');
    else if (!evidence) reasons.push('Происхождение квоты не проверено.');
    else {
      if (evidence.usable_for_observed_scenario !== true) reasons.push(evidence.reason_ru || 'Источник исключён при проверке происхождения квоты.');
      if (!ALLOWED_METHODS.has(evidence.evidence_method) && reasons.length === 0) reasons.push('Нет прямого или объединённого измерения этой пары модель + тариф.');
      if (!['high', 'medium'].includes(plan.confidence)) reasons.push('Недостаточная уверенность исходной оценки квоты.');
      if (plan.workload !== 'measured') reasons.push('Объём рассчитан через заданную смесь токенов.');
      if (evidence.token_limit_kind !== 'observed_workload') reasons.push('Нет проверенного измерения месячной ёмкости.');
      if (evidence.has_known_incomplete_counters === true) reasons.push('В исходном измерении известны неполные счётчики токенов.');
      if (evidence.has_known_mixed_models === true) reasons.push('В исходном измерении смешаны разные модели.');
    }
    if (!positive(plan.monthly_tokens) || !positive(plan.monthly_usd)) reasons.push('Нет положительных месячной платы и объёма токенов.');
    const quota = {
      id: plan.id,
      model_id: plan.model,
      model: plan.model_display,
      plan_id: plan.plan_id,
      plan: plan.plan,
      access_channel: plan.access_channel,
      confidence: plan.confidence,
      monthly_usd: plan.monthly_usd,
      monthly_tokens: plan.monthly_tokens,
      evidence_method: evidence?.evidence_method ?? 'unknown',
      token_limit_kind: evidence?.token_limit_kind ?? null,
      reason_ru: reasons.length ? [...new Set(reasons)].join(' ') : evidence.reason_ru,
      source_url: evidence?.source_url ?? plan.source_url,
      observed_mix: evidence?.observed_mix ?? null,
      observed_mix_precision: evidence?.observed_mix_precision ?? null,
      caveats_ru: evidence?.caveats_ru ?? [],
      cross_mix_transfer_confirmed: false,
      mix_transfer_status: evidence?.mix_transfer_status ?? 'not_validated',
    };
    (reasons.length ? excluded : quotas).push(quota);
  }
  const rows = [];
  for (const variant of aa.rows) {
    const estimate = estimateVariant(variant);
    const common = {
      model: variant.model_display, model_id: variant.model,
      effort: variant.effort, effort_label: variant.effort_label, effort_level: variant.effort_level,
      aa_source_id: variant.source_id, aa_source_url: variant.source,
      intelligence_index: variant.intelligence_index,
    };
    rows.push({
      ...common,
      id: `${variant.source_id}::token-api`, kind: 'api', plan: 'API · исходная стоимость AA', plan_id: 'api-aa',
      monthly_usd: null, monthly_tokens: null, subscription_price_usd_per_million: null,
      confidence: 'not_applicable', evidence_method: 'aa', source_url: variant.source,
      transfer_status: 'api', notes: estimate.notes,
      task: tokenMetrics(estimate.task, variant.cost_per_task_usd, 'task'),
      suite: tokenMetrics(estimate.suite, variant.cost_total_usd, 'suite'),
    });
    for (const quota of quotas.filter(row => row.model_id === variant.model)) {
      rows.push({
        ...common,
        id: `${variant.source_id}::token-${quota.id}`, kind: 'subscription',
        quota_id: quota.id, plan: quota.plan, plan_id: quota.plan_id, access_channel: quota.access_channel,
        monthly_usd: quota.monthly_usd, monthly_tokens: quota.monthly_tokens,
        subscription_price_usd_per_million: quota.monthly_usd / quota.monthly_tokens * 1e6,
        confidence: quota.confidence, evidence_method: quota.evidence_method, source_url: quota.source_url,
        transfer_status: 'observed_capacity_assumption',
        notes: [ASSUMPTION, quota.reason_ru, ...quota.caveats_ru, ...estimate.notes].filter(Boolean),
        task: tokenMetrics(estimate.task, variant.cost_per_task_usd, 'task', quota),
        suite: tokenMetrics(estimate.suite, variant.cost_total_usd, 'suite', quota),
      });
    }
  }
  return {
    metadata: {
      audit_valid: auditValid,
      pricing_revision: pricing.revision,
      aa_retrieved_at: aa.metadata.retrieved_at,
      method_ru: 'Цена миллиона токенов подписки = месячная плата / измеренный месячный объём × 1 000 000. Стоимость задачи или набора = месячная плата × токены соответствующего профиля AA / месячный объём.',
      assumption_ru: ASSUMPTION,
      eligibility_ru: 'Только прямые или объединённые замеры конкретной пары модель + тариф с уверенностью high/medium и достаточным учётом токенов. Вычисленные из смеси объёмы, переносы между тарифами, смешанные модели и неполные счётчики исключены.',
      effort_ru: 'При условно фиксированной ёмкости цена токена подписки одинакова для всех effort. Различаются токены на задачу, API-цена смеси AA и количество доступных задач.',
      budget_ru: 'Задач на $100 — нормировка при полном использовании месячной ёмкости, а не покупка части тарифа. Число взвешенных попыток не означает число успешно решённых задач.',
    },
    coverage: {
      total_subscription_plans: quotas.length + excluded.length,
      eligible_subscription_plans: quotas.length,
      excluded_subscription_plans: excluded.length,
      official_token_caps: 0,
      confirmed_cross_mix_transfers: 0,
      subscription_rows: rows.filter(row => row.kind === 'subscription').length,
      api_rows: rows.filter(row => row.kind === 'api').length,
    },
    quotas, excluded, rows,
  };
}
