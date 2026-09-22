# Источник и восстановление токенов AA

Снимок от 22 сентября 2026 года, Intelligence Index v4.3.2. Данные извлечены из публичного HTML страницы Astra: 42 выбранных варианта, у 39 опубликованы обе стоимости. Для сборки форка достаточно сохранённых JSON. Большие HTML-страницы в форк не включены; `node scripts/fetch_aa.mjs --refresh` получает исходную страницу заново и воспроизводит нормализацию. Источники семантики — [методология AA](https://artificialanalysis.ai/methodology/intelligence-benchmarking) и ссылки в метаданных снимка.

## Поля

| Поле `aa.json` | Исходное поле AA | Значение |
|---|---|---|
| `api_price_input_usd_per_million` | `price1mInputTokens` | Ставка обычного ввода |
| `api_price_output_usd_per_million` | `price1mOutputTokens` | Ставка вывода |
| `api_price_cache_hit_usd_per_million` | `cacheHitPrice` | Ставка чтения кеша |
| `api_price_cache_write_usd_per_million` | `cacheWritePrice` | Опубликованная ставка записи кеша; `null` сохранён |
| `api_price_reasoning_usd_per_million` | Отдельное поле не опубликовано | `null` у всех выбранных вариантов |
| `intelligence_index_output_tokens_per_task` | `intelligenceIndexOutputTokensPerTask` | Объект `reasoning`, `answer`, `output` |
| `canonical_intelligence_index_token_count` | `canonicalIntelligenceIndexTokenCount` | Исходный объект `input`, `output`, `reasoning`, `answer` полного набора |
| `reported_intelligence_index_token_count` | Отдельное поле не опубликовано | `null`; canonical-поле не переименовано в provider-reported |
| `intelligence_index_evaluations` | `intelligenceIndexEvaluations` | По каждому тесту: `slug`, `score`, `output_tokens_per_task`, `cost_per_task_usd`, `time_per_task_seconds` |

Старые поля компонентов расходов сохранены без изменения: `nonCacheInput`, `cacheRead`, `cacheWrite`, `reasoning`, `answer` — непересекающиеся компоненты; `input`, `output`, `total` — их агрегаты. При суммировании нельзя одновременно учитывать агрегаты и их части.

## Ставки и ограничения обратного расчёта

Для каждого непересекающегося типа предполагается `tokens = 1e6 * cost / price_usd_per_million`. Стоимость полного набора и взвешенная стоимость задачи требуют отдельных расчётов.

`cacheWritePrice` — полная ставка токена записи, не доплата к обычному вводу. Например, AA публикует для Opus 5 обычный ввод $5 и запись $6.25; прибавлять $5 к $6.25 нельзя. Для Fable это $10 и $12.50. [Таблица кеширования AA](https://artificialanalysis.ai/models/caching).

Когда `cacheWritePrice = null`, положительный расход `cacheWrite` всё равно присутствует. Использование обычной input-ставки для этого компонента — **выведенное правило обратного расчёта**, не опубликованная отдельная цена записи. Оно согласуется с суммарным опубликованным input у DeepSeek, Grok, MiMo и GLM. `null` не означает нулевую цену и не должен молча превращаться в ноль.

Для reasoning используется output-ставка как проверяемое предположение: отдельной reasoning-ставки в публичных объектах нет. Поле `reasoningTokens` из сырых объектов не используется: оно не является счётчиком токенов Intelligence Index.

[Методология AA](https://artificialanalysis.ai/methodology/intelligence-benchmarking) указывает, что стоимость Intelligence Index основана преимущественно на счётчиках API-провайдеров, с редким fallback на canonical tokenizer. Для измерения скорости применяется отдельная стандартизация `o200k_base`. AA также сочетает счётчики с текущей измеренной долей попаданий в кеш. Поэтому название исходного поля `canonicalIntelligenceIndexTokenCount` само по себе не доказывает ни конкретный tokenizer, ни независимое происхождение счётчика.

## Численные проверки снимка

Для 34 из 39 вариантов с расходами восстановленный output на задачу совпадает с опубликованным `intelligenceIndexOutputTokensPerTask.output` с машинной точностью. Проверка reasoning и answer отдельно также совпадает. Для этих вариантов восстановленные input и output полного набора совпадают с соответствующими полями `canonicalIntelligenceIndexTokenCount`. Сравнение с canonical-полем — проверка внутренней согласованности данных, а не доказательство совпадения с независимым журналом биллинга.

Все пять исключений — Claude Fable 5.1 Default Fallback. В таблице разница означает `(восстановлено / опубликовано − 1) * 100%`.

| Effort | Output на задачу | Output полного набора | Input полного набора |
|---|---:|---:|---:|
| low | −0.192312% | −1.201159% | +0.948458% |
| medium | −0.102275% | −1.982517% | +1.679503% |
| high | −0.055788% | −1.941714% | +1.435879% |
| xhigh | −0.207526% | −1.851273% | +1.765864% |
| max | −0.055881% | −1.972786% | +2.259503% |

Наличие Default Fallback совместимо с гипотезой смешанных ставок, но само по себе не доказывает причину расхождения. Эти варианты нельзя описывать как точное восстановление фактических токенов одной модельной ставкой; значения не подгоняются под опубликованные счётчики.

У Sol non-reasoning, Gemini 3.8 Flash low и MiMo 2.5 Pro non-reasoning нет обеих исходных стоимостей. Они остаются в наборе с `null`, без переноса расходов другого effort.

## Отличия AA от базовых ставок RAP

Для 11 из 13 выбранных моделей ставки cache/input/output AA совпадают с базовыми ставками сохранённого `data/pricing/pricing.json`. Исключения:

- MiMo 2.5 Pro: AA `0.0036 / 0.435 / 0.87`, RAP `0.2 / 1 / 3`. При фиксированной смеси RAP получаются соответственно `$0.0159075` и `$0.227` за миллион токенов; отношение около 14.27.
- GLM 5.3 Flash: AA cache `$0.026`, RAP `$0.03`; остальные ставки совпадают. При смеси RAP это `$0.030325` против `$0.034225` за миллион токенов.

Это различие источников сохранено; оно не исправляется подменой исходных цен.
