# Сайт Real API Pricing и форк

Форк создан: [closeup24/real-api-pricing](https://github.com/closeup24/real-api-pricing), основа интерфейса — `b7d9efa1f6ac50a5dfe2f6bfddcab9edf0b36c71`. Нативная вкладка «Задачи AA» находится в `web/src/AACosts.tsx`; расчёт — в `extensions/aa-costs/`. Ниже сохранены результаты предшествовавшего исследования. Упомянутые промежуточные локальные архивы не входят в форк; источники доступны по закреплённым ссылкам.

Проверено 22.09.2026. Основной расчёт проекта остаётся на commit `6489b60a14680a5ce848131d461a90eb054d03ac`; при исследовании кода текущим был `320562504daf418b707786aa68b7fac0b73b8474`. Цены и квоты этим исследованием не обновлялись. Выбранные первичные файлы сохранены в `data/research/rap/` вместе с `current-commit.json` и `LICENSE`.

## Исходники и фильтры

Каталог [web/](https://github.com/FeiZhuLulu/real-api-pricing/tree/320562504daf418b707786aa68b7fac0b73b8474/web) содержит полноценный сайт: React, TypeScript, Vite и локально упакованный Plotly. Основные файлы — `App.tsx`, `Chart.tsx`, `Ranking.tsx`, `domain.ts`. Сайт читает подготовленный снимок, а не запрашивает живые цены.

Цепочка данных: `scripts/build_adopted.py → data/adopted.csv → scripts/compute.py → derived/* → web/scripts/build-data.mjs → public/data/site.json → Vite dist`.

В [App.tsx](https://github.com/FeiZhuLulu/real-api-pricing/blob/320562504daf418b707786aa68b7fac0b73b8474/web/src/App.tsx#L88) определены группы разработчика, канала доступа, тарифа, оплаты, уверенности квоты, harness, effort и режима обслуживания. Внутри группы действует ИЛИ, между группами — И. Есть поиск и диапазоны месячной платы. В нашем отчёте применён этот принцип; harness и режим обслуживания не добавлены, поскольку для исходных цен AA и каждого продукта нет подтверждённого сопоставления.

Форк сохраняет интерфейс RAP с его наборами данных и графиками и добавляет отдельный набор AA с effort и происхождением цен. Обновления upstream отделены от пересчёта снимка AA.

Код распространяется по [MIT](https://github.com/FeiZhuLulu/real-api-pricing/blob/320562504daf418b707786aa68b7fac0b73b8474/LICENSE); при адаптации сохраняется уведомление об авторских правах. Внешние данные имеют отдельную атрибуцию в [SOURCES.md](https://github.com/FeiZhuLulu/real-api-pricing/blob/320562504daf418b707786aa68b7fac0b73b8474/SOURCES.md).

## Почему не было API-строки Astra

Скрипт создаёт API-точки только из списка [METERED](https://github.com/FeiZhuLulu/real-api-pricing/blob/320562504daf418b707786aa68b7fac0b73b8474/scripts/build_adopted.py#L589). Astra отсутствует и в нём, и в загружаемых справочниках API-ставок. Ни наличие подписок, ни общая смесь токенов не создают запись автоматически. Код не объясняет мотив автора, но технической невозможности расчёта нет.

Наши ставки Astra `$1 / $10 / $50` взяты из AA, а не из RAP. По стандартной смеси они дают `$1,365/MTok`. Происхождение дополнения сохранено в `api_baseline_origin=aa_prices_rap_mix`.

## Общий профиль и исключения

Все API-строки и справочные API blend используют 97,5% cache read / 2,15% fresh input / 0,35% output. Денежные квоты OpenCode, Command Code, Ollama и GLM Coding тоже пересчитываются по нему. Но Step использует `blended_low`: 85% / 14,65% / 0,35%. Измеренные общие квоты не приводятся повторно к стандарту; например, измерение Gemini имело 82,6% cache.

Это следует из [conventions.json](https://github.com/FeiZhuLulu/real-api-pricing/blob/320562504daf418b707786aa68b7fac0b73b8474/data/conventions.json), вызовов `blended_low` и `workload_of` в `build_adopted.py`. Оба профиля уже присутствовали в нашем сохранённом коммите. Это соглашения сравнения, а не восстановленные доли нагрузки каждой модели.
