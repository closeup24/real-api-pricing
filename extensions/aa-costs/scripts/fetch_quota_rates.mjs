import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Генератор читает только закреплённый снимок. Сеть и текущие цены не используются.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const candidates = [option('--rap-root'), resolve(root, 'real-api-pricing'), resolve(root, '../..')].filter(Boolean);
const rapRoot = candidates.map(path => resolve(path)).find(path => existsSync(resolve(path, '.git')));
if (!rapRoot) throw new Error('Нужен репозиторий RAP с закреплённым коммитом: --rap-root <путь>.');
const pricing = JSON.parse(readFileSync(resolve(root, 'data/pricing/pricing.json'), 'utf8'));
const revision = '6489b60a14680a5ce848131d461a90eb054d03ac';
assert.equal(pricing.revision, revision, 'Для нового снимка нужен повторный аудит ставок.');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sourceHashes = {};
const sourceUrl = path => `https://github.com/FeiZhuLulu/real-api-pricing/blob/${revision}/${path}`;

function readPinned(path) {
  const raw = execFileSync('git', ['-c', `safe.directory=${rapRoot.replaceAll('\\', '/')}`, '-C', rapRoot, 'show', `${revision}:${path}`], {maxBuffer: 32e6});
  sourceHashes[path] = sha256(raw);
  return raw.toString('utf8');
}

const build = readPinned('scripts/build_adopted.py');
assert.equal(sourceHashes['scripts/build_adopted.py'], pricing.source_sha256['scripts/build_adopted.py']);
const conventions = JSON.parse(readPinned('data/conventions.json'));
const opencodePath = 'data/research/opencode-go-round5-2026-09-06.json';
const opencode = JSON.parse(readPinned(opencodePath));
const opencodeDeepseekPath = 'data/research/opencode-go-deepseek-round6-2026-09-10.json';
const opencodeDeepseek = JSON.parse(readPinned(opencodeDeepseekPath));
const subscriptionsPath = 'data/research/code-subscriptions-round1-2026-09-06.json';
const subscriptions = JSON.parse(readPinned(subscriptionsPath));
const commandDeepseekPath = 'data/research/command-code-goat-deepseek-round1-2026-09-10.json';
const commandDeepseek = JSON.parse(readPinned(commandDeepseekPath));
const ollamaDeepseekPath = 'data/research/ollama-deepseek-v41-round1-2026-09-11.json';
const ollamaDeepseek = JSON.parse(readPinned(ollamaDeepseekPath));
const glmQuotasPath = 'data/research/quotas-web-2026-09.json';
const glmQuotas = JSON.parse(readPinned(glmQuotasPath));
const glmScenariosPath = 'data/research/glm-adoption-round4-2026-09-07.json';
const glmScenarios = JSON.parse(readPinned(glmScenariosPath));
const command = subscriptions.providers.find(provider => provider.id === 'command_code');
const ollama = subscriptions.providers.find(provider => provider.id === 'ollama_cloud');

/** Три исходные ставки из Python нужны для сверки research, а не для обратного расчёта квоты. */
function modelTable(name, withAllowance) {
  const block = build.match(new RegExp(`${name} = \\(\\n([\\s\\S]*?)\\n\\)`))?.[1];
  assert.ok(block, `Не найдена таблица ${name}`);
  const result = new Map();
  for (const line of block.split('\n')) {
    const match = line.match(/^\s*\("([^"]+)",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*(?:([\d.]+),\s*)?"(.*)"\),?$/);
    if (!match) continue;
    const values = match.slice(2, 6).filter(value => value !== undefined).map(Number);
    assert.equal(values.length, withAllowance ? 4 : 3);
    result.set(match[1], {allowance: withAllowance ? values.shift() : null, cacheRead: values[0], input: values[1], output: values[2], note: match[6]});
  }
  assert.ok(result.size > 0);
  return result;
}

const tables = {
  opencode: modelTable('OPENCODE_GO_MODELS', true),
  command: modelTable('COMMAND_CODE_GOAT_MODELS', true),
  ollama: modelTable('OLLAMA_MODELS', false),
};
const unique = values => [...new Set(values)];
const positive = value => Number.isFinite(value) && value > 0;
const selected = pricing.rows.filter(row => row.billing === 'subscription' && row.workload === 'standard');
assert.equal(selected.length, 36);

function dollarRow(plan) {
  let researchRates, modelQuota, sharedQuota, paths, urls, table, limits;
  const assumptions = [], notes = [], conflicts = [];
  if (plan.plan_id === 'opencode_go') {
    sharedQuota = opencode.officialSharedLimits.perMonthUsd;
    table = tables.opencode.get(plan.model);
    if (plan.model === 'deepseek-v4.1-flash') {
      const item = opencodeDeepseek.models.find(row => row.proposedModelId === plan.model);
      const rates = item.pricesPer1MUsd.offPeak;
      researchRates = {input: rates.input, cacheRead: rates.cachedInput, output: rates.output};
      modelQuota = item.perModelMonthlyUsageUsd;
      paths = [opencodePath, opencodeDeepseekPath];
    } else {
      const item = opencode.models.find(row => row.proposedModelId === plan.model);
      researchRates = item.pricesPer1M;
      modelQuota = item.perModelMonthlyUsageUsd;
      paths = [opencodePath];
    }
    urls = ['https://opencode.ai/docs/go/'];
    limits = {shared_per_5h: opencode.officialSharedLimits.per5hUsd, shared_per_week: opencode.officialSharedLimits.perWeekUsd, model_per_5h: modelQuota * 0.2, model_per_week: modelQuota * 0.5};
    if (plan.model === 'glm-5.3-flash') {
      paths.push(opencodeDeepseekPath);
      conflicts.push('В research от 2026-09-10 отмечен новый лимит GLM Flash $60, но принятая таблица RAP сохраняет $15 из 2026-09-06. Здесь сохранён именно принятый снимок $15; актуальность лимита не подтверждена.');
      assumptions.push(...conflicts);
    }
    notes.push('Короткие окна: общий пул $12/5 ч и $30/неделю; для модели — 20% и 50% её месячного лимита. Месячный расчёт предполагает возможность использовать эти окна.');
  } else if (plan.plan_id === 'command_code_goat') {
    const shared = command.plans.find(row => row.planId === plan.plan_id);
    sharedQuota = shared.monthlyCreditsUsd;
    table = tables.command.get(plan.model);
    if (plan.model === 'deepseek-v4.1-flash') {
      const item = commandDeepseek.models.find(row => row.proposedModelId === plan.model);
      const rates = item.pricesPer1MUsd.offPeak;
      researchRates = {input: rates.input, cacheRead: rates.cachedInput, output: rates.output};
      modelQuota = item.perModelMonthlyCreditsUsd;
      paths = [subscriptionsPath, commandDeepseekPath];
    } else {
      const item = command.goatPerModelAllowancesUsd.rows.find(row => row.model === plan.model);
      researchRates = item.pricesPer1M ?? item.pricesPer1MDeal;
      modelQuota = item.monthlyCreditsUsd;
      paths = [subscriptionsPath];
    }
    urls = ['https://commandcode.ai/docs/plans/goat', 'https://commandcode.ai/pricing'];
    limits = {shared_per_5h: shared.limit5hUsd, shared_per_week: shared.limitWeeklyUsd};
    assumptions.push('Месячная плата $10 не включает processing fee. Его точный размер не подтверждён; итоговая цена задачи без этой комиссии занижает полную оплату.');
    notes.push('Общий пул ограничен $14/5 ч и $35/неделю; месячный расчёт предполагает распределение запросов по окнам.');
  } else if (plan.plan_id === 'ollama_pro' || plan.plan_id === 'ollama_max') {
    const shared = ollama.plans.find(row => row.planId === plan.plan_id);
    sharedQuota = shared.monthlyCreditsUsd;
    modelQuota = null;
    table = tables.ollama.get(plan.model);
    if (plan.model === 'deepseek-v4.1-flash') {
      const rates = ollamaDeepseek.synthesis.pricesPer1MUsd.offPeakOrBase;
      researchRates = {input: rates.input, cacheRead: rates.cachedInput, output: rates.output};
      paths = [subscriptionsPath, ollamaDeepseekPath];
    } else {
      researchRates = ollama.modelPricesPer1MFromPricingPage.rows.find(row => row.model === plan.model);
      paths = [subscriptionsPath];
    }
    urls = ['https://ollama.com/pricing', 'https://ollama.com/blog/transparent-pricing'];
    limits = {concurrent_requests: shared.concurrentRequests};
    notes.push('Отдельный месячный лимит модели в сохранённых официальных данных не найден; расчёт расходует на одну модель весь общий пул. Неиспользованные credits не переносятся.');
  } else throw new Error(`Неизвестный долларовый канал ${plan.id}`);
  assert.ok(table && researchRates);
  for (const key of ['cacheRead', 'input', 'output']) assert.equal(researchRates[key], table[key], `${plan.id}: конфликт ставки ${key}`);
  if (modelQuota != null) assert.equal(modelQuota, table.allowance, `${plan.id}: конфликт принятого лимита`);
  assert.ok(positive(sharedQuota));
  const amount = modelQuota == null ? sharedQuota : Math.min(sharedQuota, modelQuota);
  if (plan.model.startsWith('deepseek-')) notes.push(plan.plan_id.startsWith('ollama_')
    ? 'Использованы ставки off-peak; peak у Ollama — пн–пт 12:00–18:00 UTC, ставки вдвое выше.'
    : 'Использованы ставки off-peak; peak — пн–пт 01:00–04:00 и 06:00–10:00 UTC, ставки вдвое выше.');
  if (plan.plan_id === 'opencode_go' && plan.model === 'gpt-5.6-luna') notes.push('Принята нижняя ценовая ступень ≤272K контекста. Для длинных запросов ставки иные; одного суммарного количества токенов AA недостаточно для выбора ступени.');
  if (plan.plan_id === 'opencode_go' && plan.model === 'grok-4.6') notes.push('Принята нижняя ценовая ступень ≤200K контекста. Выше порога ставки удваиваются; распределение длины запросов AA здесь не моделируется.');
  return {quota_unit: 'USD', monthly_quota: amount, rates: researchRates,
    original_quota: {period: 'month', amount, periods_per_month: 1, shared_pool_amount: sharedQuota, model_pool_amount: modelQuota},
    rate_basis: 'Ставки канала подписки в USD за 1 000 000 токенов; USD означает долларовый номинал usage credits.',
    quota_basis_status: conflicts.length ? 'assumed' : 'documented',
    source_urls: [...paths.map(sourceUrl), ...urls], assumptions_ru: assumptions, notes_ru: notes,
    source_conflicts_ru: conflicts, additional_limits: limits,
    shared_pool_note: modelQuota == null ? 'Общий месячный пул по сценарию целиком расходуется на эту модель; объёмы разных моделей не складываются.' : 'Эффективная квота — min(общий месячный пул, лимит модели). Пулы моделей не независимы; их объёмы нельзя складывать.'};
}

function glmRow(plan) {
  const match = plan.plan_id.match(/^glm_coding_(lite|pro|max)_cn_(new|old)_(peak|mid|offpeak)$/);
  assert.ok(match, `Неизвестный тариф GLM ${plan.id}`);
  const [, tier, generation, band] = match;
  const tierName = tier[0].toUpperCase() + tier.slice(1);
  const pool = glmQuotas.glmOfficialQuotaTable95Cache.credits[tierName];
  const ratesMatch = build.match(/"glm-5\.3-flash": \(([\d.]+), ([\d.]+), ([\d.]+)\)/);
  assert.ok(ratesMatch);
  const [cacheRead, input, output] = ratesMatch.slice(1).map(value => {
    const [whole, fraction = ''] = value.split('.');
    return Number(BigInt(whole + fraction) * 100n) / 10 ** fraction.length;
  });
  const capacityMultiplier = glmScenarios.scenarios.find(row => row.idSuffix === band).creditMultiplier;
  // В исходнике коэффициенты на 10 000 токенов. Пул не увеличиваем: меняются только ставки.
  const rateMultiplier = 1 / capacityMultiplier;
  const assumptions = ['Недельный пул приведён к условному месяцу из четырёх недель по конвенции RAP; это не новый официальный месячный лимит.'];
  if (band === 'mid') assumptions.push('Mid — сценарий RAP: среднее арифметическое ёмкостей peak/off-peak, то есть peak × 1.5. При неизменном пуле ставки равны peak × 2/3; это не официальный тариф и не смесь 50/50 токенов по времени.');
  if (generation === 'old') assumptions.push('Строка использует legacy V2 цену со значениями pools/rates V3, как в принятой таблице RAP. Источник отмечает различие систем квот V2/V3; перенос на старый тариф не подтверждён.');
  return {quota_unit: 'points', monthly_quota: pool.perWeek * conventions.monthWeeks,
    rates: {cacheRead: cacheRead * rateMultiplier, input: input * rateMultiplier, output: output * rateMultiplier},
    original_quota: {period: 'week', amount: pool.perWeek, periods_per_month: conventions.monthWeeks, shared_pool_amount: pool.perWeek, model_pool_amount: null},
    rate_basis: `Баллы за 1 000 000 токенов: исходные коэффициенты на 10 000 токенов × 100 / ${capacityMultiplier}. Пул одинаков для всех временных сценариев.`,
    quota_basis_status: generation === 'old' ? 'assumed' : 'documented',
    source_urls: [sourceUrl(glmQuotasPath), sourceUrl(glmScenariosPath), 'https://docs.bigmodel.cn/cn/coding-plan/overview'],
    assumptions_ru: assumptions,
    notes_ru: ['Peak: пн–пт 14:00–18:00 UTC+8. В off-peak официальный расход составляет 50% базового.', 'Квота ограничена недельным и пятичасовым окнами; месячный результат предполагает их полное использование.', 'Расчёт включает только пять токенных категорий AA. Возможные отдельные расходы инструментов не восстановлены из этих категорий.'],
    source_conflicts_ru: [], additional_limits: {per_5h: pool.per5h, per_week: pool.perWeek},
    capacity_multiplier: capacityMultiplier, charge_multiplier: 1 / capacityMultiplier,
    shared_pool_note: 'Общие баллы Coding Plan расходуются на все модели; здесь весь пул выделен GLM 5.3 Flash. Peak, mid и off-peak — альтернативные сценарии одного пула, их нельзя складывать.'};
}

const rows = selected.map(plan => {
  const evidence = plan.plan_id.startsWith('glm_coding_') ? glmRow(plan) : dollarRow(plan);
  const explicitWrite = Number.isFinite(evidence.rates.cacheWrite) && evidence.rates.cacheWrite >= 0;
  const assumptions = [...evidence.assumptions_ru];
  if (!explicitWrite) assumptions.push('Отдельная ставка cache write в сохранённой таблице не указана. Принята обычная input-ставка; отсутствие отдельной записи не считается доказанным нулевым тарифом.');
  assumptions.push('Reasoning-токены сопоставлены опубликованной ставке output. Отдельное подтверждение этого сопоставления в сохранённых данных канала отсутствует.');
  const componentRates = {non_cache_input: evidence.rates.input, cache_read: evidence.rates.cacheRead, cache_write: explicitWrite ? evidence.rates.cacheWrite : evidence.rates.input, answer: evidence.rates.output, reasoning: evidence.rates.output};
  const rateStatus = {non_cache_input: 'documented', cache_read: 'documented', cache_write: explicitWrite ? 'documented' : 'assumed', answer: 'documented', reasoning: 'assumed'};
  if (plan.plan_id.startsWith('glm_coding_') && (plan.plan_id.includes('_old_') || plan.plan_id.endsWith('_mid'))) for (const key of Object.keys(rateStatus)) rateStatus[key] = 'assumed';
  const available = positive(evidence.monthly_quota) && Object.values(componentRates).every(value => Number.isFinite(value) && value >= 0);
  const {rates, ...detail} = evidence;
  return {id: plan.id, model_id: plan.model, plan: plan.plan, monthly_usd: plan.monthly_usd,
    ...detail, component_rates: componentRates, component_rate_status: rateStatus,
    status: available ? assumptions.length ? 'assumed' : 'documented' : 'unavailable',
    assumptions_ru: assumptions,
    source_urls: unique([sourceUrl('scripts/build_adopted.py'), ...evidence.source_urls]),
    notes_ru: [...evidence.notes_ru, 'Состав AA переносится в расчёт расхода credits; воспроизведение той же доли cache hits на другом канале не гарантировано. Полное использование месячного пула является условием оценки.']};
});

assert.equal(new Set(rows.map(row => row.id)).size, 36);
const statuses = Object.fromEntries(['documented', 'assumed', 'unavailable'].map(status => [status, rows.filter(row => row.status === status).length]));
const manifest = {schema_version: 1, metadata: {
  pricing_revision: pricing.revision, pricing_retrieved_at_utc: pricing.retrieved_at_utc, retrieved_at_utc: pricing.retrieved_at_utc,
  pricing_rows_sha256: sha256(JSON.stringify(pricing.rows)),
  generated_by: 'scripts/fetch_quota_rates.mjs', source_sha256: sourceHashes, rows: rows.length, status_counts: statuses,
  component_rate_unit: 'quota_unit per 1 000 000 tokens',
  method_ru: 'Квоты и ставки взяты из исходных credits/points и таблиц research закреплённого RAP. monthly_tokens, real_price и фиксированная смесь не используются для восстановления квоты.',
  status_policy_ru: 'documented требует однозначного сопоставления всех пяти категорий и условий тарифа; assumed допускает явно перечисленные допущения; unavailable означает недостаточные данные для арифметики. Официальность базового пула не устраняет неопределённость сопоставления cache write/reasoning.',
  snapshot_policy_ru: 'Используются принятые условия снимка, включая отмеченные в нём конфликты. Текущие страницы не опрашиваются; исходные pricing.json и monthly_tokens не изменяются.',
}, rows};
const output = `${JSON.stringify(manifest, null, 2)}\n`;
const path = resolve(root, 'data/pricing/quota-rates.json');
if (args.includes('--check')) assert.equal(readFileSync(path, 'utf8'), output, 'Manifest отличается от результата воспроизводимого извлечения.');
else writeFileSync(path, output, 'utf8');
console.log(JSON.stringify({rows: rows.length, statuses, explicitly_priced_cache_write_rows: rows.filter(row => row.component_rate_status.cache_write === 'documented').length, check: args.includes('--check')}));
