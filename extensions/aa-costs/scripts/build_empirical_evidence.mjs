import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Воспроизводимый аудит сохранённых наблюдений: без сети и синтетической смеси RAP.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const rapRoot = resolve(option('--rap-root') || resolve(root, '../..'));
const sourceRevision = 'b7d9efa1f6ac50a5dfe2f6bfddcab9edf0b36c71';
const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const pricing = read('data/pricing/pricing.json');
const audit = read('data/pricing/quota-evidence.json');
const quotaRates = read('data/pricing/quota-rates.json');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sourceHashes = {};
const cache = new Map();
const sourceUrl = path => `https://github.com/FeiZhuLulu/real-api-pricing/blob/${sourceRevision}/${path}`;
const unique = values => [...new Set(values.filter(Boolean))];

// Отдельный проверенный первоисточник дополняет закреплённый пересказ, не меняя его байты.
const claudeMaxReviewPath = 'data/pricing/claude-max-source-review.json';
const claudeMaxReviewBytes = readFileSync(resolve(root, claudeMaxReviewPath));
const claudeMaxReview = JSON.parse(claudeMaxReviewBytes.toString('utf8'));
const claudeMaxReviewHash = sha256(claudeMaxReviewBytes);
assert.equal(claudeMaxReview.schema_version, 1);
assert.equal(claudeMaxReview.pinned_summary.revision, sourceRevision);
assert.equal(claudeMaxReview.current_observation.reported_api_equivalent_usd, 1222);
assert.equal(claudeMaxReview.current_observation.quota_fraction_used, .52);
assert.equal(claudeMaxReview.current_observation.window_start_date, '2026-09-17');
assert.deepEqual(claudeMaxReview.current_observation.source_model_ids, ['Opus 4.6', 'Fable 5.1']);
assert.equal(claudeMaxReview.audit_conclusion.direct_opus_5_measurement, false);
assert.equal(claudeMaxReview.current_observation.normalization.promotion_correction, 1);
assert.equal(claudeMaxReview.counterfactual_not_observed.use_as_measured_cost, false);

function pinned(path) {
  if (!cache.has(path)) {
    const raw = execFileSync('git', ['-c', `safe.directory=${rapRoot.replaceAll('\\', '/')}`, '-C', rapRoot, 'show', `${sourceRevision}:${path}`], { maxBuffer: 32e6 });
    sourceHashes[path] = sha256(raw);
    cache.set(path, JSON.parse(raw.toString('utf8')));
  }
  return cache.get(path);
}

const paths = {
  openaiPrices: 'data/chatgpt-pro-claims.json',
  sol: 'data/research/chatgpt-quotas-round5-2026-09.json',
  solGateway: 'data/research/chatgpt-pro20x-gateway-measurement-2026-09-06.json',
  luna: 'data/research/chatgpt-luna-adoption-round6-2026-09-08.json',
  astraPlus: 'data/research/chatgpt-astra-adoption-round7-2026-09-11.json',
  astra: 'data/research/chatgpt-astra-round12-2026-09-16.json',
  astra13: 'data/research/chatgpt-astra-sameframe-round13-2026-09-20.json',
  astra14: 'data/research/chatgpt-astra-round14-2026-09-21.json',
  claudePro: 'data/research/claude-adoption-round8-2026-09-20.json',
  claudeMaxBase: 'data/research/claude-adoption-round6-2026-09-06.json',
  claudeMax: 'data/research/claude-adoption-round7-2026-09-14.json',
  claudeMaxCheck: 'data/research/claude-adoption-round9-2026-09-21.json',
  fable: 'data/research/claude-fable51-round3-2026-09-20.json',
  fablePolicy: 'data/research/claude-fable51-round1-2026-09-13.json',
  gemini: 'data/research/gemini-weekly-round7-2026-09-21.json',
  devin: 'data/research/devin-usage-round4-2026-09-14.json',
  grok: 'data/research/quotas-web-round2-2026-09.json',
  grokCheck: 'data/research/quotas-web-round3-2026-09.json',
  cursor: 'data/research/cursor-adoption-round8-2026-09-06.json',
  cursorScreenshots: 'data/research/cursor-user-screenshot-round7-2026-09-06.json',
  quotaReports: 'data/research/quotas-web-2026-09.json',
  cursorFast: 'data/research/cursor-fast-round6-2026-09-05.json',
  grok47: 'data/research/supergrok-grok47-round1-2026-09-22.json',
};
const data = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, pinned(path)]));
const fullPoints = pinned('derived/points.json');
const auditedMethods = new Set(['direct_measurement', 'pooled_measurements', 'calibrated_measurement', 'plan_extrapolation']);
const present = new Set(quotaRates.rows.map(row => row.id));
const pricingById = new Map(pricing.rows.map(row => [row.id, row]));
const rowsHash = sha256(JSON.stringify(pricing.rows));
assert.equal(audit.metadata.pricing_rows_sha256, rowsHash, 'Аудит относится к другому снимку цен.');
assert.equal(quotaRates.metadata.pricing_rows_sha256, rowsHash, 'Ставки относятся к другому снимку цен.');

const methodLabels = {
  direct_measurement: 'Наблюдённая ёмкость подписки',
  pooled_measurements: 'Несколько практических измерений',
  calibrated_measurement: 'Измерение с поправками',
  plan_extrapolation: 'Перенос практического измерения между тарифами',
};
const calibrationNote = 'API-эквивалент наблюдения делится на долю квоты и приводится к месяцу. Перенос на AA предполагает пропорциональность списания квоты API-стоимости; отдельные внутренние веса подписки этим не доказаны.';
const claudeProDateCaveat = 'recordedAt 20 сентября — дата аудита RAP, а не подтверждённая дата сеанса Pro. Дополнительная промокоррекция не применяется без основания.';
const missingWeightsNote = 'Наблюдённый общий объём токенов не задаёт расход квоты на другой смеси. Для цены задачи AA нужны ставки по категориям либо API-стоимость полного замера и соответствующая доля квоты.';

function references(row) {
  if (row.model_id === 'gpt-5.6-sol') return [paths.sol, paths.solGateway];
  if (row.model_id === 'gpt-5.6-luna') return [paths.luna];
  if (row.model_id === 'gpt-6-astra') return row.id.startsWith('devin_') ? [paths.devin] : [paths.astraPlus, paths.astra, paths.astra13, paths.astra14];
  if (row.model_id === 'claude-opus-5') return row.id.startsWith('claude_pro::') ? [paths.claudePro] : [paths.claudeMaxBase, paths.claudeMax, paths.claudeMaxCheck];
  if (row.model_id === 'claude-fable-5.1') return [paths.fable, paths.claudeMaxBase, paths.claudeMax, paths.claudeMaxCheck];
  if (row.model_id === 'gemini-3.8-flash') return [paths.gemini];
  if (row.id.startsWith('cursor_')) return [paths.cursor, paths.cursorScreenshots, paths.grokCheck];
  if (row.id.startsWith('supergrok')) return [paths.grok, paths.grokCheck];
  throw new Error(`Не заданы источники ${row.id}`);
}

function component(label, tokens, rate) {
  return { label, tokens, rate_usd_per_million: rate };
}

function calibrate(row, observation, reason, notes, urls = []) {
  const keys = observation.input_kind === 'reported_monthly_pool' ? ['reported_monthly_pool_usd', 'plan_multiplier'] : ['observed_api_usd', 'quota_fraction', 'periods_per_month', 'plan_multiplier'];
  for (const key of keys) assert.ok(observation[key] > 0, `${row.id}: ${key}`);
  row.method = 'empirical_api_calibration';
  row.basis_label = row.evidence_method === 'plan_extrapolation' ? 'API-калибровка замера с переносом тарифа' : 'API-калибровка практического замера';
  row.reason_ru = reason;
  row.calibration = observation;
  delete row.missing_data_ru;
  row.notes_ru = unique([observation.input_kind === 'reported_monthly_pool'
    ? 'Исходная величина — сообщённый месячный внутренний денежный пул. Его перевод в API-эквивалент и API-пропорциональные веса списания приняты условно; это не наблюдение расхода всей квоты.'
    : calibrationNote, ...notes]);
  row.source_urls = unique([...row.source_urls, ...urls]);
}

function scenario(row, observation, reason, notes, urls = []) {
  calibrate(row, observation, reason, notes, urls);
  row.method = 'empirical_api_scenario';
  row.basis_label = observation.input_kind === 'reported_monthly_pool' ? 'Приблизительный сценарий по сообщённой квоте' : 'Приблизительный сценарий по наблюдению';
  row.quality = {level: 'low', reasons: unique([reason, ...notes])};
}

const rows = audit.rows.filter(row => !present.has(row.id) && auditedMethods.has(row.evidence_method) && row.token_limit_kind === 'observed_workload').map(evidence => {
  const plan = pricingById.get(evidence.id);
  assert.ok(plan && plan.monthly_tokens > 0 && plan.monthly_usd > 0, `Нет исходного тарифа ${evidence.id}`);
  const row = {
    id: evidence.id,
    model_id: evidence.model_id,
    monthly_usd: plan.monthly_usd,
    monthly_tokens: plan.monthly_tokens,
    method: 'unavailable_quota_weights',
    evidence_method: evidence.evidence_method,
    basis_label: methodLabels[evidence.evidence_method],
    reason_ru: `Историческая оценка RAP, не используемая как ёмкость для AA: ${evidence.reason_ru}`,
    confidence: evidence.confidence,
    token_limit_kind: 'observed_workload',
    missing_data_ru: missingWeightsNote,
    notes_ru: unique([missingWeightsNote, ...evidence.caveats_ru.map(note => `Ограничение исходной оценки RAP: ${note}`)]),
    source_urls: unique([evidence.source_url, evidence.calculation_source_url, ...references(evidence).map(sourceUrl)]),
  };

  if (row.model_id === 'gpt-5.6-sol') {
    // Отбираем по составу моделей, а не по получившейся цене; общий pooled содержит также Astra.
    const models = ['gpt-5.6-sol', 'gpt-5.6-luna'];
    const selected = data.solGateway.segments.filter(segment => segment.includedInPooled
      && segment.byModel?.['gpt-5.6-sol'] && Object.keys(segment.byModel).every(model => models.includes(model)));
    assert.deepEqual(selected.map(segment => data.solGateway.segments.indexOf(segment)), [0, 1, 2, 9]);
    for (const segment of selected) {
      assert.equal(Object.values(segment.byModel).reduce((total, sample) => total + sample.promptTokens + sample.outputTokens, 0), segment.totalTokens);
    }
    const components = models.flatMap(model => {
      const totals = selected.reduce((total, segment) => {
        const sample = segment.byModel[model];
        if (sample) {
          assert.ok(sample.promptTokens >= sample.cacheReadTokens);
          total.input += sample.promptTokens - sample.cacheReadTokens;
          total.cache += sample.cacheReadTokens;
          total.output += sample.outputTokens;
        }
        return total;
      }, { input: 0, cache: 0, output: 0 });
      const rates = data.openaiPrices.apiPrices[`${model}_short`];
      return [component(`${model}: обычный вход`, totals.input, rates.input), component(`${model}: чтение кэша`, totals.cache, rates.cached), component(`${model}: выход`, totals.output, rates.output)];
    });
    const fraction = selected.reduce((total, segment) => total + segment.deltaPercent, 0) / 100;
    assert.equal(fraction, .27);
    const cost = components.reduce((total, item) => total + item.tokens * item.rate_usd_per_million / 1e6, 0);
    assert.ok(Math.abs(cost - 582.41610292) < 1e-8);
    const multiplier = { chatgpt_plus: 1 / 20, chatgpt_pro_5x: 1 / 4, chatgpt_pro_20x: 1 }[plan.plan_id];
    assert.ok(multiplier);
    row.evidence_method = multiplier === 1 ? 'pooled_measurements' : 'plan_extrapolation';
    calibrate(row, { observed_api_usd: cost, quota_fraction: fraction, periods_per_month: 4, plan_multiplier: multiplier, sample_components: components },
      'Четыре сегмента gateway Pro 20x с Sol и Luna: полные вход/cache/output и суммарный расход 27 процентных пунктов недельной квоты.', [
        'Вход получен как promptTokens минус cacheReadTokens; выход не прибавляется к prompt повторно. Сегменты с Astra и другими моделями не используются.',
        'Luna составляет около 3.1% токенов и 0.28% API-стоимости. Предполагается общая API-пропорциональность списания Sol и Luna; модельные внутренние веса не проверены.',
        'Проценты округлены, синхронизация логов сдвинута примерно на пять минут; возможны накладные списания окна. Стандартные API-ставки применены без отдельной поправки на неизвестные Fast/длинный контекст.',
        multiplier === 1 ? 'Практическое основание Pro 20x: сегменты 0, 1, 2, 9 из закреплённого источника, 21–31 августа.' : `Пул Pro 20x умножен на ${multiplier} по соотношению уровней тарифа; это явный перенос между подписками, не независимый полный замер ${plan.plan}.`,
        'Отдельные сегменты дают примерно $8252–9065 API-эквивалента за четыре недели; разброс не является доверительным интервалом. Принята сумма расходов, делённая на сумму процентов.',
      ], [sourceUrl(paths.solGateway), sourceUrl(paths.openaiPrices)]);
  }

  if (row.model_id === 'gpt-6-astra' && plan.plan_id === 'devin_max') {
    const item = data.devin.items[0], sample = item.observedSegment.modelRow;
    assert.equal(item.model, row.model_id);
    assert.equal(sample.input + sample.cacheRead + sample.cacheCreate + sample.output, sample.total);
    calibrate(row, {
      observed_api_usd: (sample.input * 10 + sample.cacheRead + sample.cacheCreate * 12.5 + sample.output * 50) / 1e6,
      quota_fraction: item.observedSegment.deltaPercentPoints / 100, periods_per_month: 4, plan_multiplier: 1,
      sample_components: [component('Обычный вход', sample.input, 10), component('Чтение кэша', sample.cacheRead, 1), component('Запись кэша: сопоставление с AA', sample.cacheCreate, 12.5), component('Выход', sample.output, 50)],
    }, 'Devin Max: 305 025 580 токенов Astra high с полной разбивкой четырёх категорий соответствуют 87% недельной квоты.', [
      'API-стоимость восстановлена нами по ставкам AA; это не сумма, считанная с панели. CacheCreate сопоставлен с cache write AA по $12.5/M, TTL и режим контекста в источнике не указаны.',
      'При цене cacheCreate $10/M или $20/M оценка пула была бы соответственно $1639.31 или $1809.84 вместо $1681.94 за четыре недели. Это чувствительность к ставке, не доверительный интервал.',
      'Источник — пользовательская панель, сохранённая в RAP; другие модели исключены по сообщению автора, что они не расходовали эту квоту. Принято одно недельное окно без сброса и округлённые 87%.',
      'Замер high переносится на другие effort при гипотезе одинаковых API-пропорциональных правил списания. Ранее принятые 1.402 млрд токенов в месяце не используются.',
    ], [sourceUrl(paths.devin)]);
  }

  if (row.model_id === 'gpt-5.6-luna') {
    const sample = data.luna.items[0].observed;
    const rates = data.luna.items[1].crossCheck.pricesPerMTokenUsd;
    const cost = (sample.inputTokens * rates.input + sample.cacheReadTokens * rates.cacheRead + sample.outputTokens * rates.output) / 1e6;
    assert.ok(Math.abs(cost - 3.21851192) < 1e-10);
    const multiplier = { chatgpt_plus: 1, chatgpt_pro_5x: 5, chatgpt_pro_20x: 20 }[plan.plan_id];
    calibrate(row, {
      observed_api_usd: cost, quota_fraction: sample.weeklyUsedFractionDisplayed, periods_per_month: 4, plan_multiplier: multiplier,
      sample_components: [component('Обычный вход', sample.inputTokens, rates.input), component('Чтение кэша', sample.cacheReadTokens, rates.cacheRead), component('Выход, включая reasoning', sample.outputTokens, rates.output)],
    }, 'Полный срез Luna на Plus: 112 666 769 токенов и 6% недельной квоты; стоимость восстановлена по фактическим категориям, без фиксированной смеси.', [
      'Reasoning входит в output и повторно не прибавляется. Процент 6% округлён; один аккаунт и один срез.',
      multiplier === 1 ? 'Прямой замер Plus от 2026-09-08.' : `Пул Plus умножается на ${multiplier}; это перенос между тарифами, а не независимый замер Pro.`,
      'API-эквивалент Luna не переносится на другие модели: их внутренние веса могут отличаться.',
    ], data.luna.items.map(item => item.source));
  }

  if (row.model_id === 'gpt-6-astra' && plan.plan_id === 'chatgpt_plus') {
    // Три категории из одного замера позволяют сравнить планы при общей гипотезе API-весов.
    const sample = data.astra13.items.find(item => item.id === 'g4');
    assert.equal(sample.plan, 'chatgpt_plus');
    assert.equal(sample.model, 'gpt-6-astra');
    assert.match(sample.claim, /0\.514M\+cache 3\.948M\+输出0\.016M=4\.478M/);
    assert.match(sample.claim, /14%/);
    row.confidence = sample.confidence;
    row.evidence_method = 'direct_measurement';
    calibrate(row, {
      observed_api_usd: (514_000 * 10 + 3_948_000 + 16_000 * 50) / 1e6,
      quota_fraction: .14, periods_per_month: 4, plan_multiplier: 1,
      sample_components: [component('Обычный вход', 514_000, 10), component('Чтение кэша', 3_948_000, 1), component('Выход по записи источника', 16_000, 50)],
    }, 'Plus, round13 / g4: в RAP записаны 514 000 токенов входа, 3 948 000 чтения кэша и 16 000 выхода за 14% недельной квоты. Все три тарифа Astra теперь используют API-калибровку.', [
      'Источник — сохранённый в RAP пересказ пользовательского замера; публичной ссылки на исходную панель нет. Дата 2026-09-20 относится к сбору, а не обязательно к самому замеру.',
      'Отдельный cache write, длина контекста, Fast и состав reasoning не раскрыты. Использование стандартных ставок $10/$1/$50 и трактовка 16 000 как совокупного выхода остаются допущениями.',
      'Выбран g4 с 14% расхода и medium, а не g1 с 2% и low: округление малой доли сильнее влияет на результат. Это один замер, не установленный лимит подписки.',
      'Чувствительность: другой замер g1 даёт (72 402 × 10 + 1 200 256 × 1 + (7 468 + 2 964) × 50) / 1 000 000 / 0.02 × 4 = $489.1752 API-эквивалента за четыре недели вместо $282.514286 у g4. Если reasoning уже входит в output, получится $459.5352. Расход задачи при таком замере составил бы примерно 58–61% основной оценки. Это альтернативные допущения, не доверительный интервал.',
      'Прежние 159 млн токенов из round7 оставлены в исходном RAP для справки. В них отсутствовал output; перенос этой ёмкости без поправки на смесь давал другую модель расчёта и не применяется здесь.',
      'Более высокая месячная плата не гарантирует меньшую цену задачи: при пропорциональном росте платы и ёмкости цена задачи одинакова. Для сравнения тарифов выбирайте одинаковые модель и effort.',
    ], [sourceUrl(paths.astra13)]);
  }

  if (row.model_id === 'gpt-6-astra' && ['chatgpt_pro_20x', 'chatgpt_pro_5x'].includes(plan.plan_id)) {
    const pro20 = plan.plan_id === 'chatgpt_pro_20x';
    const item = data.astra.items[pro20 ? 1 : 3];
    const sample = pro20 ? item.observed.window1 : item.observed;
    const input = pro20 ? sample.uncachedInput : sample.uncachedInputTokens;
    const cached = pro20 ? sample.cachedInput : sample.cachedInputTokens;
    const output = pro20 ? sample.outputIncludingReasoning : sample.outputTokens;
    row.evidence_method = 'direct_measurement';
    calibrate(row, {
      observed_api_usd: (input * 10 + cached + output * 50) / 1e6,
      quota_fraction: (pro20 ? sample.claimedUsedPercent : sample.deltaPercentPoints) / 100,
      periods_per_month: 4, plan_multiplier: 1,
      sample_components: [component('Обычный вход', input, 10), component('Чтение кэша', cached, 1), component('Выход, включая reasoning', output, 50)],
    }, pro20 ? 'V2EX: полный срез Astra 605 074 493 токена при заявленных 75% недельной квоты Pro 20x.' : 'Prolite / Pro 5x: 198 428 302 токена при изменении недельного расхода 0% → 86%.', [
      pro20 ? 'Lightweight/medium, без Fast, контекст <272K. Cache write проверен автором и равен нулю; соответствие окна 75% заявлено автором.' : 'Срез включает основной агент, три дочерних агента и guardian (3.7% токенов). Чистота одной модели не полностью подтверждена; план в источнике стоит €100, здесь использован тариф снимка $100.',
      'monthly_tokens сохраняет принятый RAP агрегат для справки; API-калибровка использует этот конкретный срез, а не агрегированный token proxy.',
      'Astra Plus имеет отдельные условия limited-доступа; этот пул не получен умножением Plus на 5 или 20.',
    ], [item.source]);
  }

  if (plan.plan_id === 'claude_pro' && row.model_id === 'claude-opus-5') {
    const sample = data.claudePro.panelReading;
    calibrate(row, { observed_api_usd: sample.sessionCostUsd, quota_fraction: sample.weeklyPctUsed, periods_per_month: 4, plan_multiplier: 1 },
      'Панель Claude Pro: $25.72 API-эквивалента сеанса и 7% общей недельной квоты.', [
        'Один MED-сеанс; 7% взято из текста автора, недельная полоса на кадре обрезана. Это округлённое наблюдение, не официальный лимит.',
        'Сумма включает Opus 5, небольшую примесь Haiku и web search; их стоимость не вычитается из общего расхода общей квоты.',
        'В исходном сеансе cache write имеет TTL 1 час ($10/M); AA может использовать другой TTL. Полная сумма панели округлена до центов.',
        claudeProDateCaveat,
      ]);
  }

  if (row.model_id === 'gemini-3.8-flash') {
    const sample = data.gemini.items[0].observed.bTotal;
    const multiplier = { google_ai_pro_us: 1, google_ai_ultra_5x_us: 5, google_ai_ultra_20x_us: 20 }[plan.plan_id];
    assert.ok(multiplier);
    calibrate(row, { observed_api_usd: sample.worthUsd, quota_fraction: sample.deltaPct / 100, periods_per_month: 4, plan_multiplier: multiplier },
      'Gemini 3.8 Flash: наблюдённые $11.86 token worth соответствуют 9.88% недельной квоты Google AI Pro.', [
        'Использованы $11.86 / 9.88% напрямую; округлённая производная $120.1 в расчёт не подставляется.',
        'Категории и стоимость в источнике округлены; недельная трактовка полосы сообщена пользователем, второго аккаунта нет.',
        multiplier === 1 ? 'Прямой замер Google AI Pro в Antigravity.' : `Официальный коэффициент token worth ${multiplier}× переносит замер Pro на Ultra; независимого замера Ultra нет.`,
        'API-цены в наблюдении относятся к вводному тарифу до 2026-12-31; одинаковое списание новых условий не гарантируется.',
      ], ['https://antigravity.google/docs/plans']);
  }

  if (row.model_id === 'claude-fable-5.1') {
    const sample = data.fable.items[0].rawData.snapshot1;
    assert.equal(sample.cacheRead, 283_000_000);
    assert.equal(sample.output, 2_600_000);
    assert.equal(sample.weeklyPct, 19);
    assert.equal(data.claudeMaxBase.adoption.weeklyPoolRatio20xTo5x, 2);
    const multiplier = plan.plan_id === 'claude_max_20x' ? 1 : .5;
    row.evidence_method = multiplier === 1 ? 'calibrated_measurement' : 'plan_extrapolation';
    scenario(row, {
      observed_api_usd: (sample.cacheRead * .25 + sample.output * 50) / 1e6,
      quota_fraction: sample.weeklyPct / 100, periods_per_month: 4, plan_multiplier: multiplier,
      sample_components: [component('Весь смешанный замер как Fable: чтение кэша', sample.cacheRead, .25), component('Весь смешанный замер как Fable: выход', sample.output, 50)],
      corrections: [{label: 'Снять временное увеличение квоты в 1.5 раза', factor: 1 / 1.5}, {label: 'Постоянное увеличение лимита после промопериода', factor: 1.25}, {label: 'Доступная Fable доля недельного пула', factor: .5}],
    }, 'По выбранному сценарию весь смешанный замер Opus/Fable оценивается как Fable: 283 млн чтения кэша и 2.6 млн выхода за 19% общей недельной квоты.', [
      'Состав известных токенов можно разделить: Fable 171 млн cache read и 1.5 млн output, Opus 112 млн и 1.1 млн. Отдельный расход процентов квоты каждой моделью неизвестен; здесь обе части намеренно приписаны Fable.',
      'Обычный вход и запись кэша не измерены полностью и не включены в стоимость образца. Их отсутствие не означает нулевого расхода; при прочих равных это уменьшает оценку пула и повышает цену задачи.',
      'Дата замера исправлена источником на 4–5 сентября: снят промомножитель 1.5 и применено постоянное увеличение 1.25, затем модельный лимит Fable 50%. Эти условия перенесены из сохранённых материалов RAP.',
      'Max 20x определён предположительно. Для Max 5x пул делится на 2 по принятому RAP отношению недельных пулов; независимого замера 5x нет. При половинной плате и квоте цены задач двух планов совпадают по построению.',
      'В источнике отдельно сообщается, что снижение API-цены cache read не изменило списание подписки. API-веса для переноса на AA остаются условной моделью и могут искажать цену при другом составе токенов.',
    ], [sourceUrl(paths.fablePolicy)]);
  }
  if (row.model_id === 'claude-opus-5' && plan.plan_id.startsWith('claude_max_')) {
    const sample = claudeMaxReview.current_observation;
    const multiplier = plan.plan_id === 'claude_max_20x' ? 1 : .5;
    row.evidence_method = multiplier === 1 ? 'calibrated_measurement' : 'plan_extrapolation';
    scenario(row, {
      observed_api_usd: sample.reported_api_equivalent_usd,
      quota_fraction: sample.quota_fraction_used,
      periods_per_month: sample.normalization.four_weeks_multiplier, plan_multiplier: multiplier,
      quota_assumption: 'unobserved_target_model',
      source_models: [...sample.source_model_ids], source_model_id_kind: sample.source_model_id_kind,
      source_model_spend_shares: sample.model_spend_shares,
      window_start_date: sample.window_start_date, quota_scope: sample.quota_scope,
      source_review: {path: claudeMaxReviewPath, sha256: claudeMaxReviewHash},
    }, 'Claude Max 20x: автор сообщает $1222 API-эквивалента за 52% общей недельной квоты. Нагрузка — 93% стоимости Opus 4.6 и 7% Fable 5.1; равный денежный пул для Opus 5 принят как гипотеза.', [
      'В пересказе RAP потеряно точное название модели: первоисточник называет Opus 4.6, а не Opus 5. Это не прямой замер целевой модели; буквальные названия источника не заменены проверенными API ID.',
      'Используется полный сообщённый автором API-эквивалент $1222. Таблица округлённых категорий даёт $1223, а её пересчёт по единым указанным Opus-ставкам — $1223.875; суммы не выравниваются. Полной разбивки категорий по моделям и TTL нет.',
      '$1306 — гипотетическая переоценка кэша Fable по $1/M вместо $0.25/M; это не измеренный расход и не поправка TTL. Она не используется.',
      'Текущая неделя началась со сброса 17 сентября; дополнительная промопоправка 1.25/1.5 не применяется. Предыдущая неделя пересекала 14 сентября и в этот расчёт не входит.',
      multiplier === 1 ? 'Исходник — сообщение автора Siigari и его уточнения в той же ветке для одного аккаунта Max 20x.' : 'Max 5x получает половину пула Max 20x по ранее принятой гипотезе RAP; это не официальный коэффициент и не независимый замер Max 5x.',
      'Для переноса на Opus 5 предполагается равный денежный пул и API-пропорциональность списания на составе AA. Автор не установил надёжного соответствия между API-стоимостью и счётчиком квоты. Доли 93%/7% относятся к API-стоимости; помодельное списание квоты не измерено.',
    ], [claudeMaxReview.sources.post_url, claudeMaxReview.sources.comments_read_url,
      claudeMaxReview.sources.model_mix_comment_url, claudeMaxReview.sources.category_table_comment_url,
      claudeMaxReview.sources.cache_repricing_comment_url]);
    row.source_urls = unique([claudeMaxReview.sources.post_url, ...row.source_urls]);
  }
  if (plan.plan_id === 'cursor_pro_plus') {
    const item = data.grokCheck.items[0];
    assert.equal(item.planId, 'cursor_pro_plus');
    row.evidence_method = 'direct_measurement';
    scenario(row, {observed_api_usd: 214.74, quota_fraction: .268, periods_per_month: 1, plan_multiplier: 1},
      'Cursor Pro+: внутренние $214.74 compute cost соответствуют 26.8% месячного пула Cursor Models.', [
        'Для сценария внутренний доллар Cursor условно приравнен к публичному API-доллару Grok. Категории замера и реальный коэффициент перевода неизвестны.',
        'Пул общий для Grok и Composer; в расчёте он полностью выделен выбранной модели. Other Models не добавляется.',
        'Обзорный источник сообщает иной пул Pro+ около $450; здесь принят прямой счётчик cents/% около $801.27. Конфликт не разрешён.',
      ], [item.source, sourceUrl(paths.quotaReports)]);
  } else if (plan.plan_id.startsWith('cursor_')) {
    const report = data.quotaReports.items[14];
    assert.equal(report.model, 'Cursor Models + Other Models (dashboard reports)');
    const fast = plan.plan_id === 'cursor_ultra_fast';
    const pool = plan.plan_id === 'cursor_pro' ? 300 : 3000;
    row.evidence_method = 'reported_quota';
    row.quota_rate_multiplier = fast ? 2 : 1;
    scenario(row, {input_kind: 'reported_monthly_pool', reported_monthly_pool_usd: pool, plan_multiplier: 1},
      `Cursor Models: в обзорном источнике сообщается месячный пул около $${pool}; это сообщение о ёмкости, а не замер расхода 100%.`, [
        'Публично пересказанный внутренний денежный пул условно приравнен к API-эквиваленту. Полной связанной записи токенов и процента квоты нет.',
        'Указан только Cursor Models, общий для Grok/Composer. Отдельный Other Models не прибавляется; весь пул условно выделен Grok.',
        fast ? 'Fast использует удвоенные ставки списания после восстановления токенов AA. Пул не уменьшается дополнительно; качество и объёмы задач AA не меняются.' : 'Применены стандартные API-ставки Grok как условные веса внутреннего списания.',
      ], [report.source, sourceUrl(paths.quotaReports), ...(fast ? [sourceUrl(paths.cursorFast), 'https://cursor.com/docs/models/grok-4-6'] : [])]);
  }
  if (row.model_id === 'grok-4.6' && plan.plan_id.startsWith('supergrok')) {
    const item = data.grokCheck.items[5];
    const multiplier = {supergrok: 1, supergrok_plus: 4, supergrok_heavy: 10}[plan.plan_id];
    assert.ok(multiplier);
    row.evidence_method = multiplier === 1 ? 'calibrated_measurement' : 'plan_extrapolation';
    scenario(row, {
      observed_api_usd: 64.51, quota_fraction: .26, periods_per_month: 4, plan_multiplier: multiplier,
      corrections: [{label: 'Снять удвоенную квоту первой недели', factor: .5}],
    }, 'SuperGrok 4.6: пользователь сообщает $64.51 расходов за 26% квоты в первую неделю с удвоенным лимитом.', [
      'Денежная единица сообщения условно считается публичной API-стоимостью. Полной разбивки по категориям и проверки ступенчатого тарифа нет.',
      'Общий пул приведён к обычной неделе делением на 2; другие сообщения о размере пула противоречат друг другу.',
      multiplier === 1 ? 'Основание — один приблизительный пользовательский замер.' : `Пул перенесён на ${plan.plan} с множителем ${multiplier} по отношению номиналов панели; независимого замера нет.`,
    ], [item.source]);
  }
  if (row.method === 'empirical_api_calibration') {
    const extrapolated = row.evidence_method === 'plan_extrapolation';
    const lowSource = String(row.confidence).toLowerCase().includes('low');
    row.quality = {level: extrapolated || lowSource ? 'low' : 'medium', reasons: unique([
      row.reason_ru,
      extrapolated ? 'Квота получена переносом с другого тарифа, а не независимым замером этой подписки.' : 'Есть связанный практический замер расхода и доли квоты; охват аккаунтов и повторов ограничен.',
      lowSource ? 'Исходный источник RAP также имеет низкую оценку надёжности.' : '',
      calibrationNote,
      row.id === 'claude_pro::claude-opus-5' ? claudeProDateCaveat : '',
    ])};
  }
  if (row.model_id === 'claude-opus-5' && ['claude_pro', 'claude_max_5x', 'claude_max_20x'].includes(plan.plan_id)) {
    row.quality.reasons = unique([...row.quality.reasons, 'Сравнение Pro и Max использует разные аккаунты и модельные нагрузки; полученное преимущество Pro по цене задачи не подтверждено сопоставимым замером.']);
  }
  row.source_urls = unique(row.source_urls);
  return row;
});

// Дополнительные пары не заменяют закреплённый снимок pricing.
const additionalPlans = ['supergrok', 'supergrok_plus', 'supergrok_heavy'].map(planId => {
  const id = `${planId}::grok-4.7`;
  const point = fullPoints.points.find(item => item.id === id);
  const adoption = data.grok47.adoption[planId];
  assert.ok(point && adoption && point.workload === 'measured');
  const monthlyTokens = Math.round(adoption.monthlyYi * 1e8);
  assert.equal(monthlyTokens, Math.round(point.monthly_yi * 1e8));
  const plan = {
    id, model: 'grok-4.7', model_display: 'Grok 4.7', plan_id: planId, plan: point.plan,
    billing: 'subscription', monthly_usd: point.price_usd, monthly_tokens: monthlyTokens,
    confidence: adoption.confidence, workload: 'measured', source_url: sourceUrl(paths.grok47),
  };
  const row = {
    id, model_id: plan.model, monthly_usd: plan.monthly_usd, monthly_tokens: monthlyTokens,
    evidence_method: planId === 'supergrok' ? 'calibrated_measurement' : 'plan_extrapolation',
    confidence: adoption.confidence, token_limit_kind: 'observed_workload',
    source_urls: [sourceUrl(paths.grok47), sourceUrl('derived/points.json')],
  };
  const sessions = data.grok47.rawObservations.sessions.filter(session => Number.isFinite(session.inputTokens));
  assert.equal(sessions.length, 2);
  const measured = sessions.reduce((total, session) => {
    assert.equal(session.inputTokens + session.outputTokens, session.totalTokens);
    total.input += session.inputTokens - session.cachedInputTokens;
    total.cache += session.cachedInputTokens;
    total.output += session.outputTokens;
    return total;
  }, {input: 0, cache: 0, output: 0});
  const cost = (measured.input * 2 + measured.cache * .5 + measured.output * 6) / 1e6;
  assert.ok(Math.abs(cost - 9.948764) < 1e-10);
  const multiplier = {supergrok: 1, supergrok_plus: 4, supergrok_heavy: 10}[planId];
  scenario(row, {
    observed_api_usd: cost, quota_fraction: .08, periods_per_month: 4, plan_multiplier: multiplier,
    sample_components: [component('Обычный вход двух известных сеансов', measured.input, 2), component('Чтение кэша двух известных сеансов', measured.cache, .5), component('Выход, уже включающий reasoning', measured.output, 6)],
  }, 'SuperGrok 4.7: API-стоимость двух известных сеансов восстановлена по их категориям; им условно приписано 8% недельной квоты.', [
    'Полный прирост квоты — 9%; третья сессия удалена. Ей условно отнесён 1%, поэтому оставшиеся 8% не являются измеренным расходом этих двух сеансов.',
    'Стоимость $9.948764 вычислена по стандартным API-ставкам. Противоречивое поле CLI Cost не используется; длина контекста, смешанные подмодели и возможные акции не установлены.',
    'Reasoning уже входит в output и не прибавляется повторно. При 7–9% вместо 8% базовый пул составил бы $442.17–568.50 за четыре недели; это чувствительность к допущению, не доверительный интервал.',
    multiplier === 1 ? 'Основание — один аккаунт с неполной историей сеансов.' : `Пул перенесён на ${point.plan} с множителем ${multiplier} по номиналам панели; независимого замера нет.`,
  ]);
  rows.push(row);
  return plan;
});

// Opus 5.5 получает прежний денежный пул, а не прежнее число токенов и не переоценённый замер.
for (const planId of ['claude_pro', 'claude_max_5x', 'claude_max_20x']) {
  const sourceId = `${planId}::claude-opus-5`;
  const sourcePlan = pricingById.get(sourceId);
  const sourceEvidence = rows.find(row => row.id === sourceId);
  assert.ok(sourcePlan && sourceEvidence, `Нет исходной квоты ${sourceId}`);
  const id = `${planId}::claude-opus-5.5`;
  const assumption = 'Гипотеза: для Opus 5.5 и Opus 5 на одном тарифе Claude доступен одинаковый денежный API-эквивалент квоты. Прямых замеров Opus 5.5 пока нет.';
  const sourceUrls = unique([...sourceEvidence.source_urls,
    'https://platform.claude.com/docs/en/about-claude/pricing',
    'https://artificialanalysis.ai/models/claude-opus-5-5',
  ]);
  additionalPlans.push({
    id, model: 'claude-opus-5.5', model_display: 'Claude Opus 5.5',
    plan_id: planId, plan: sourcePlan.plan.replace(' (9/14+)', ''),
    billing: 'subscription', monthly_usd: sourcePlan.monthly_usd,
    model_provider: 'Anthropic', access_channel: 'Claude', workload: 'model_transfer',
    source_url: sourceUrls[0],
  });
  rows.push({
    id, model_id: 'claude-opus-5.5', monthly_usd: sourcePlan.monthly_usd,
    method: 'empirical_model_transfer', evidence_method: 'model_transfer',
    basis_label: 'Гипотеза переноса денежной квоты Opus 5 → Opus 5.5',
    reason_ru: assumption,
    transfer: {source_pricing_id: sourceId, source_model_id: 'claude-opus-5', confidence: 'medium', assumption_ru: assumption},
    source_urls: sourceUrls,
    notes_ru: [
      'Перенос имеет среднюю уверенность как гипотеза, а итоговая надёжность не выше исходного основания Opus 5. Эта оценка не подтверждает наличие прямого измерения Opus 5.5.',
      planId === 'claude_pro' ? 'Пул восстанавливается по старым ставкам и наблюдениям Opus 5; расходы новых задач — по собственным категориям и ставкам Opus 5.5 из AA.' : 'Денежный пул Opus 5 сам принят по смешанному замеру Opus 4.6/Fable 5.1. Перенос этого условного пула на Opus 5.5 добавляет ещё одну гипотезу; расходы новой модели берутся из её AA-профиля.',
      'Общий бюджет считается доступным одной выбранной модели. Квоты двух Opus внутри одной подписки не суммируются; месячный эквивалент использует четыре недели.',
      'Изменения пятичасовых ограничений при релизе не считаются подтверждённым увеличением недельного денежного пула.',
    ],
  });
}

// Новое поколение GPT наследует денежное основание только своей модели и своего тарифа.
for (const family of ['sol', 'luna']) {
  const sourceModel = `gpt-5.6-${family}`;
  const model = `gpt-6-${family}`;
  const name = family === 'sol' ? 'Sol' : 'Luna';
  for (const planId of ['chatgpt_plus', 'chatgpt_pro_5x', 'chatgpt_pro_20x']) {
    const sourceId = `${planId}::${sourceModel}`;
    const sourcePlan = pricingById.get(sourceId);
    const sourceEvidence = rows.find(row => row.id === sourceId);
    assert.ok(sourcePlan && sourceEvidence, `Нет исходной квоты ${sourceId}`);
    assert.equal(sourcePlan.model, sourceModel);
    assert.equal(sourcePlan.plan_id, planId);
    assert.equal(sourcePlan.billing, 'subscription');
    assert.equal(sourcePlan.model_provider, 'OpenAI');
    assert.equal(sourcePlan.access_channel, 'ChatGPT');
    assert.equal(sourceEvidence.method, 'empirical_api_calibration');
    const id = `${planId}::${model}`;
    const assumption = `Гипотеза: для GPT-6 ${name} и GPT-5.6 ${name} на одном тарифе ChatGPT доступен одинаковый денежный API-эквивалент квоты. В используемом срезе нет прямых замеров GPT-6 ${name}.`;
    const sourceUrls = unique([...sourceEvidence.source_urls, `https://artificialanalysis.ai/models/${model}`]);
    additionalPlans.push({
      id, model, model_display: `GPT-6 ${name}`,
      plan_id: sourcePlan.plan_id, plan: sourcePlan.plan,
      billing: sourcePlan.billing, monthly_usd: sourcePlan.monthly_usd,
      model_provider: sourcePlan.model_provider, access_channel: sourcePlan.access_channel, workload: 'model_transfer',
      source_url: sourceUrls[0],
    });
    rows.push({
      id, model_id: model, monthly_usd: sourcePlan.monthly_usd,
      method: 'empirical_model_transfer', evidence_method: 'model_transfer',
      basis_label: `Гипотеза переноса денежной квоты GPT-5.6 ${name} → GPT-6 ${name}`,
      reason_ru: assumption,
      transfer: {source_pricing_id: sourceId, source_model_id: sourceModel, confidence: 'medium', assumption_ru: assumption},
      source_urls: sourceUrls,
      notes_ru: [
        `Перенос имеет среднюю уверенность как гипотеза, а итоговая надёжность не выше исходного основания GPT-5.6 ${name}. В используемых данных нет прямого измерения GPT-6 ${name}.`,
        `Пул восстанавливается по исходным ставкам и наблюдениям GPT-5.6 ${name}; расходы новых задач — по собственным категориям и ставкам GPT-6 ${name} из AA. Старые токены не переоцениваются по новым ставкам.`,
        'Тариф, месячная плата и канал сохраняются от исходной пары. Уже имеющийся перенос между тарифами остаётся ограничением источника и не становится независимым замером.',
        'Общий бюджет выделяется одной выбранной модели; ёмкости старой и новой моделей в одной подписке нельзя складывать. Недельные замеры приводятся к четырём неделям.',
        'Страница AA подтверждает профиль новой модели, но не равенство лимитов или правил списания подписки. Это равенство принято только как явно обозначенная гипотеза.',
      ],
    });
  }
}

assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'Повторная пара тариф/модель.');
assert.ok(rows.every(row => !present.has(row.id)), 'Эмпирический метод не должен заменять документированные ставки.');
const counts = Object.fromEntries(unique(rows.map(row => row.method)).map(method => [method, rows.filter(row => row.method === method).length]));
const result = {
  schema_version: 1,
  metadata: {
    pricing_revision: pricing.revision,
    pricing_retrieved_at_utc: pricing.retrieved_at_utc,
    retrieved_at_utc: pricing.retrieved_at_utc,
    pricing_rows_sha256: rowsHash,
    source_revision: sourceRevision,
    source_sha256: sourceHashes,
    local_source_reviews: {[claudeMaxReviewPath]: {
      sha256: claudeMaxReviewHash, retrieved_at: claudeMaxReview.retrieved_at,
      primary_source_url: claudeMaxReview.sources.post_url,
      pinned_summary: claudeMaxReview.pinned_summary,
    }},
    generated_by: 'scripts/build_empirical_evidence.mjs',
    rows: rows.length,
    method_counts: counts,
    method_ru: 'Объёмы для цены задачи берутся только из AA. Связанные замеры дают условную API-калибровку, неполные замеры и сообщения о пулах — отдельные сценарии низкой надёжности с явными допущениями. Общая токенная ёмкость RAP и фиксированная смесь не используются.',
    quality_policy_ru: 'Надёжность оценивается для переноса квоты на нагрузку AA: средняя — связанный замер с API-гипотезой, низкая — неполный/смешанный образец, внутренние денежные единицы, сообщённый пул или перенос между тарифами. Оценка RAP сохраняется отдельно и автоматически не наследуется.',
    period_note_ru: 'Недельные наблюдения приводятся к четырём неделям; это не календарный месяц. Пулы общие для моделей одного тарифа: ёмкости нельзя складывать.',
    source_policy_ru: 'Снимок pricing и его аудит сохранены. Research и три дополнительные пары Grok 4.7 прочитаны из закреплённого коммита; их точные байты проверяются SHA-256. Для Claude Max пересказ уточнён отдельным локальным аудитом первоисточника claude-max-source-review.json, с собственным SHA-256 и датой получения в local_source_reviews; закреплённый RAP не переписан. Три пары Opus 5.5 и шесть пар GPT-6 Sol/Luna добавлены отдельно как гипотезы переноса денежного пула Opus 5 и соответствующих GPT-5.6 Sol/Luna внутри того же тарифа, без выдуманного токенного лимита. Страницы AA новых моделей служат источниками профилей, а не доказательством одинаковых подписочных лимитов.',
  },
  rows,
  additional_plans: additionalPlans,
  excluded: [{
    id: 'supergrok_lite::grok-4.6',
    reason_ru: 'Нет проверяемого измерения недельной квоты или исходного пула SuperGrok Lite; историческое число токенов не позволяет восстановить условия расчёта.',
    source_urls: [pricingById.get('supergrok_lite::grok-4.6')?.source_url, sourceUrl(paths.grok), sourceUrl(paths.grok47)].filter(Boolean),
  }],
};
const destination = resolve(option('--out') || resolve(root, 'data/pricing/empirical-evidence.json'));
writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: destination, rows: rows.length, methods: counts, additional_plans: additionalPlans.length }));
