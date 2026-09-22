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
  gemini: 'data/research/gemini-weekly-round7-2026-09-21.json',
  devin: 'data/research/devin-usage-round4-2026-09-14.json',
  grok: 'data/research/quotas-web-round2-2026-09.json',
  grokCheck: 'data/research/quotas-web-round3-2026-09.json',
  cursor: 'data/research/cursor-adoption-round8-2026-09-06.json',
  cursorScreenshots: 'data/research/cursor-user-screenshot-round7-2026-09-06.json',
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
  for (const key of ['observed_api_usd', 'quota_fraction', 'periods_per_month', 'plan_multiplier']) assert.ok(observation[key] > 0, `${row.id}: ${key}`);
  row.method = 'empirical_api_calibration';
  row.basis_label = row.evidence_method === 'plan_extrapolation' ? 'API-калибровка замера с переносом тарифа' : 'API-калибровка практического замера';
  row.reason_ru = reason;
  row.calibration = observation;
  delete row.missing_data_ru;
  row.notes_ru = unique([calibrationNote, ...notes]);
  row.source_urls = unique([...row.source_urls, ...urls]);
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

  if (plan.plan_id === 'cursor_pro_plus') {
    const item = data.grokCheck.items[0];
    assert.equal(item.planId, 'cursor_pro_plus');
    row.evidence_method = 'direct_measurement';
    row.reason_ru = 'Cursor Pro+: наблюдённые $214.74 compute cost составляют 26.8% месячного пула Cursor Models.';
    row.missing_data_ru = 'Пул $214.74 / 26.8% измерен во внутренних единицах Cursor. Нет ставок списания категорий или коэффициента перевода в публичную API-стоимость Grok; подставлять его как API-бюджет нельзя.';
    row.notes_ru = [missingWeightsNote,
        'Это внутренний compute-cost пул Cursor Models, измеренный по totalCents, а не доказанный эквивалент публичных долларов API xAI.',
        'Пул включает Grok 4.5/4.6 и Composer 2.5; показатель 26.8% округлён, доступный объём делится между моделями.',
        'Не смешивать этот пул с Other Models и его отдельными условиями.',
      ];
    row.source_urls.push(item.source);
  }
  if (row.method === 'unavailable_quota_weights') {
    if (row.model_id === 'claude-opus-5') {
      row.missing_data_ru = 'Для Claude Max нет полного замера Opus 5 с категориями токенов и соответствующим расходом недельной квоты. Позднее наблюдение 2.1 млрд cache read за 52% не содержит остальных категорий; модель полного месячного лимита из него не определяется.';
      row.notes_ru.push('Частичное наблюдение round9 сохранено как свидетельство, а не точечный бюджет. Исторические сообщённые API-бюджеты имеют другую эпоху/неясную версию модели и не заменяют полный замер.');
    } else if (row.model_id === 'claude-fable-5.1') {
      row.missing_data_ru = 'Замер Claude Max смешивает Opus и Fable: 19% относятся к общему расходу, input/cache write отсутствуют, отдельная доля квоты Fable неизвестна. Разделить её через общий raw-token объём без дополнительных весов нельзя.';
    } else if (plan.plan_id.startsWith('cursor_') && plan.plan_id !== 'cursor_pro_plus') {
      row.missing_data_ru = 'Есть общее число токенов и процент пула Cursor, но нет полной разбивки и ставок внутреннего compute cost. Денежная реконструкция через фиксированную смесь RAP не используется.';
    } else if (row.model_id === 'grok-4.6' && plan.plan_id.startsWith('supergrok')) {
      row.missing_data_ru = 'Замер SuperGrok содержит общий raw-token объём без категорий. Номинальные доллары панели и сообщения о расходах не определяют проверенный публичный API-эквивалент; перенос на смесь AA пока недоступен.';
    }
  }
  row.source_urls = unique(row.source_urls);
  return row;
});

// Дополнение только для трёх новых пар Grok 4.7; полный снимок pricing не заменяется.
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
  rows.push({
    id, model_id: plan.model, monthly_usd: plan.monthly_usd, monthly_tokens: monthlyTokens,
    method: 'unavailable_quota_weights',
    evidence_method: planId === 'supergrok' ? 'calibrated_measurement' : 'plan_extrapolation',
    basis_label: planId === 'supergrok' ? 'Измерение с неполным сеансом' : 'Перенос измерения SuperGrok 4.7',
    reason_ru: 'Известные 13 442 816 токенов двух сеансов отнесены к предполагаемым 8% недельной квоты; ещё один сеанс удалён.',
    missing_data_ru: 'Для двух известных сеансов Grok 4.7 нет измеренной доли квоты: третья сессия удалена, её вклад неизвестен. Предполагаемые 8% и противоречивый CLI Cost не используются для API-калибровки.',
    confidence: adoption.confidence, token_limit_kind: 'observed_workload',
    notes_ru: [missingWeightsNote,
      'Общая полоса выросла с 19% до 28%; доля удалённого сеанса условно принята равной 1%, а двух известных — 8%. Это предположение, не полный контролируемый замер.',
      'Принятый диапазон базы примерно 597–768 млн токенов за четыре недели; возможны смешанные вызовы/контекстные тарифы и вводная акция.',
      'Доллары панели SuperGrok не тождественны долларам публичного API; поле CLI Cost противоречиво и для API-калибровки не используется.',
      planId === 'supergrok' ? 'Базовый план: одно наблюдение одного аккаунта.' : `Перенос на ${point.plan} по отношению номиналов квоты панели ${planId === 'supergrok_plus' ? '100/25' : '250/25'}; независимого замера этого плана нет.`,
    ],
    source_urls: [sourceUrl(paths.grok47), sourceUrl('derived/points.json')],
  });
  return plan;
});

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
    generated_by: 'scripts/build_empirical_evidence.mjs',
    rows: rows.length,
    method_counts: counts,
    method_ru: 'Объёмы для цены задачи берутся только из AA. Полные наблюдения API-стоимости и процента квоты дают условную калибровку ставок; остальные тарифы сохраняются без цены с перечислением недостающих данных. Общая токенная ёмкость RAP и фиксированная смесь не используются.',
    period_note_ru: 'Недельные наблюдения приводятся к четырём неделям; это не календарный месяц. Пулы общие для моделей одного тарифа: ёмкости нельзя складывать.',
    source_policy_ru: 'Снимок pricing и его аудит сохранены. Research и три дополнительные пары Grok 4.7 прочитаны из закреплённого коммита; их точные байты проверяются SHA-256.',
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
