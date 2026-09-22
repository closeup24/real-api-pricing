# Цены для расчёта стоимости задач

`pricing.json` содержит 77 строк: 62 сочетания подписки и модели, 13 базовых API-строк и два варианта DeepSeek off-peak. `coverage.json` показывает покрытие 13 моделей.

Основной источник — [Real API Pricing](https://github.com/FeiZhuLulu/real-api-pricing), commit `6489b60a14680a5ce848131d461a90eb054d03ac` от 22 сентября 2026 года. Зафиксированные исходники лежат в `raw/`; их SHA-256 включены в `pricing.json`. Исходные пояснения сохранены на языке автора.

Выполнение `python scripts/fetch_pricing.py` воспроизводит нормализацию из локальных файлов. Параметр `--refresh` загружает новый фиксированный снимок GitHub. API-цены отсутствующих в RAP моделей берутся из текущего `data/aa/aa.json`, извлечённого из публичных данных Artificial Analysis. Поэтому при обновлении сначала запускается `node scripts/fetch_aa.mjs --refresh`.

## Поля

Каждая строка `rows` содержит `model`, `model_display`, `plan_id`, `plan`, `billing`, `monthly_usd`, `monthly_tokens`, `real_price_usd_per_million`, `api_price_usd_per_million`, `coefficient`, `confidence`, `source`, `source_url`, `note` и `warnings`.

- `billing`: `subscription` или `metered`.
- `is_api_baseline`: основная API-строка модели; её коэффициент равен 1. Off-peak — отдельный вариант с коэффициентом 0,5.
- `api_price_components`: исходные ставки `cache`, `input`, `output` в долларах за миллион токенов.
- `api_baseline_kind`, `api_source`, `api_source_url`: происхождение API-базы.
- `quota_effort`: `null`; исходник не подтверждает одинаковый расход квоты на каждом effort.

## Формулы и точность

`real_price_usd_per_million = monthly_usd * 1e6 / monthly_tokens`.

`api_price_usd_per_million = cache * 0.975 + input * 0.0215 + output * 0.0035`.

`coefficient = real_price_usd_per_million / api_price_usd_per_million`.

Стоимость AA для каждого effort умножается на `coefficient`. Доли токенов взяты из стандартной смеси RAP. При этом прямые измерения квот RAP имеют собственный состав нагрузки: коэффициент остаётся сценарной оценкой при полном использовании подписки.

Промежуточные величины рассчитаны без дополнительного округления; опубликованные квоты уже могут быть округлёнными. Для тарифов в юанях используется исходная местная цена и курс RAP 6,7787 CNY/USD. Округлённые цены RAP сохранены отдельно.

## Покрытие и ограничения

- GPT-5.6 Luna, GPT-5.6 Sol, GPT-6 Astra, Claude Opus 5, Claude Fable 5.1, Gemini 3.8 Flash, DeepSeek V4.1 Flash, DeepSeek V4 Flash 0731, Grok 4.6, MiMo V2.5 Pro и GLM 5.3 Flash имеют подписки.
- Для Grok 4.7 и MiMo V2.6 Pro опубликованных квот подписки в этом снимке RAP нет: доступны только API-строки. Квоты предыдущих версий не подставлялись.
- Соответствие `deepseek-v4-flash` снимку `DeepSeek-V4-Flash-0731` явно указано в `raw/data__official-api-prices.json`.
- API-база Astra, Gemini 3.8 Flash, Grok 4.7 и MiMo V2.6 Pro рассчитана из точных ставок AA и смеси RAP.
- API-база MiMo V2.5 Pro в RAP использует ставки cache/input/output 0,2/1/3, тогда как AA использует 0,0036/0,435/0,87. У GLM 5.3 Flash RAP cache=0,03, AA cache=0,026. Эти различия нужно учитывать при интерпретации пересчитанной стоимости AA.

MIT-лицензия проекта RAP не меняет лицензии его внешних источников: происхождение и примечания сохранены в `raw/SOURCES.md`.
