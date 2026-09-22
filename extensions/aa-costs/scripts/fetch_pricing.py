"""Загружает фиксированный снимок тарифов и готовит цены для графиков."""

from __future__ import annotations

import argparse
import ast
import csv
import hashlib
import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "pricing"
RAW = OUT / "raw"
REPOSITORY = "FeiZhuLulu/real-api-pricing"
FILES = [
    "data/adopted.csv",
    "data/conventions.json",
    "derived/points.json",
    "data/official-api-prices.json",
    "data/README.md",
    "README.md",
    "SOURCES.md",
    "scripts/build_adopted.py",
    "data/research/list-prices-2026-09.json",
]
MODELS = {
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-6-astra": "GPT-6 Astra",
    "claude-opus-5": "Claude Opus 5",
    "claude-fable-5.1": "Claude Fable 5.1",
    "gemini-3.8-flash": "Gemini 3.8 Flash",
    "deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
    "deepseek-v4-flash": "DeepSeek V4 Flash 0731",
    "grok-4.6": "Grok 4.6",
    "grok-4.7": "Grok 4.7",
    "mimo-v2.5-pro": "MiMo V2.5 Pro",
    "mimo-v2.6-pro": "MiMo V2.6 Pro",
    "glm-5.3-flash": "GLM 5.3 Flash",
}
AA_FALLBACK = {
    "gpt-6-astra": "gpt-6-astra",
    "gemini-3.8-flash": "gemini-3-8-flash",
    "grok-4.7": "grok-4-7",
    "mimo-v2.6-pro": "mimo-v2-6-pro",
}
MODEL_PROVIDER_FALLBACK = {
    "grok-4.7": "xAI",
    "mimo-v2.6-pro": "Xiaomi",
}
ACCESS_CHANNEL_PREFIXES = {
    "chatgpt_": "ChatGPT", "claude_": "Claude", "google_ai_": "Google AI",
    "devin_": "Devin", "supergrok": "SuperGrok", "cursor_": "Cursor",
    "glm_coding_": "GLM Coding", "opencode_": "OpenCode Go",
    "command_code_": "Command Code", "ollama_": "Ollama",
}


def access_channel(plan_id, billing):
    """Группирует известные ID тарифов по продукту, через который доступна модель."""
    if billing == "metered":
        return "API"
    return next((label for prefix, label in ACCESS_CHANNEL_PREFIXES.items() if plan_id.startswith(prefix)), "Не указан")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def raw_path(path):
    return RAW / path.replace("/", "__")


def decimal(value):
    return Decimal(str(value))


def download(url, target):
    request = Request(url, headers={"User-Agent": "ai-price-research"})
    with urlopen(request, timeout=45) as response:
        target.write_bytes(response.read())


def normalize(refresh=False):
    RAW.mkdir(parents=True, exist_ok=True)
    if refresh or not (RAW / "commit.json").exists():
        download(f"https://api.github.com/repos/{REPOSITORY}/commits/main", RAW / "commit.json")
    commit = read_json(RAW / "commit.json")
    revision = commit["sha"]
    for path in FILES:
        if refresh or not raw_path(path).exists():
            download(f"https://raw.githubusercontent.com/{REPOSITORY}/{revision}/{path}", raw_path(path))

    conventions = read_json(raw_path("data/conventions.json"))
    mixture = {key: decimal(conventions["standardTokenMix"][key]) for key in ("cache", "input", "output")}
    fx = decimal(conventions["usdPerCny"])
    source_points = read_json(raw_path("derived/points.json"))
    points = {point["id"]: point for point in source_points["points"]}
    model_providers = {point["model"]: point["vendor"] for point in source_points["points"] if point.get("vendor")}
    adopted = list(csv.DictReader(raw_path("data/adopted.csv").open(encoding="utf-8-sig", newline="")))
    list_prices = {row["model"]: row for row in read_json(raw_path("data/research/list-prices-2026-09.json"))["models"]}

    # Читаем только литералы массива METERED, не выполняя чужой Python-код.
    syntax_tree = ast.parse(raw_path("scripts/build_adopted.py").read_text(encoding="utf-8-sig"))
    metered = None
    for statement in syntax_tree.body:
        if isinstance(statement, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "METERED" for target in statement.targets):
            metered = ast.literal_eval(statement.value)
            break
    if metered is None:
        raise ValueError("В исходном скрипте отсутствует массив METERED")
    metered_by_id = {row[0]: row for row in metered}
    metered_by_model = {}
    for row in metered:
        metered_by_model.setdefault(row[2], []).append(row)

    aa_path = ROOT / "data" / "aa" / "aa.json"
    if aa_path.exists():
        aa_original = read_json(aa_path)
        aa_prices_by_model = {}
        for row in aa_original["rows"]:
            if row["model"] not in AA_FALLBACK:
                continue
            aa_prices_by_model.setdefault(row["model"], {
                "slug": AA_FALLBACK[row["model"]],
                "cacheHitPrice": row["api_price_cache_hit_usd_per_million"],
                "price1mInputTokens": row["api_price_input_usd_per_million"],
                "price1mOutputTokens": row["api_price_output_usd_per_million"],
            })
        aa_prices = list(aa_prices_by_model.values())
        save_json(RAW / "aa-api-fallbacks.json", aa_prices)
    elif (RAW / "aa-api-fallbacks.json").exists():
        aa_prices = read_json(RAW / "aa-api-fallbacks.json")
    else:
        aa_prices = []
    aa_by_slug = {row["slug"]: row for row in aa_prices}

    def blended(components):
        return sum(decimal(components[key]) * mixture[key] for key in mixture)

    def metered_components(row):
        return dict(zip(("cache", "input", "output"), row[3:6]))

    baselines = {}
    for model in MODELS:
        if model in metered_by_model:
            candidates = metered_by_model[model]
            row = next((item for item in candidates if item[0].endswith("_peak")), candidates[0])
            components = metered_components(row)
            baselines[model] = {
                "components": components,
                "price": blended(components),
                "kind": "rap_metered_components",
                "plan_id": row[0],
                "source": row[6],
                "source_url": f"https://github.com/{REPOSITORY}/blob/{revision}/scripts/build_adopted.py",
            }
        elif model in list_prices:
            row = list_prices[model]
            if all(row.get(key) is not None for key in ("cachedInput", "input", "output")):
                components = {"cache": row["cachedInput"], "input": row["input"], "output": row["output"]}
                baselines[model] = {
                    "components": components,
                    "price": blended(components),
                    "kind": "rap_list_price_components",
                    "plan_id": None,
                    "source": row["source"],
                    "source_url": f"https://github.com/{REPOSITORY}/blob/{revision}/data/research/list-prices-2026-09.json",
                }
        elif model in AA_FALLBACK and AA_FALLBACK[model] in aa_by_slug:
            row = aa_by_slug[AA_FALLBACK[model]]
            components = {"cache": row["cacheHitPrice"], "input": row["price1mInputTokens"], "output": row["price1mOutputTokens"]}
            if any(value is None for value in components.values()):
                continue
            baselines[model] = {
                "components": components,
                "price": blended(components),
                "kind": "aa_prices_rap_mix",
                "plan_id": None,
                "source": "Artificial Analysis: цены API из публичных данных, смесь токенов Real API Pricing",
                "source_url": f"https://artificialanalysis.ai/models/{row['slug']}",
            }

    rows = []
    for adopted_row in adopted:
        model = adopted_row["served_model"]
        if model not in MODELS:
            continue
        plan_id = adopted_row["plan_id"]
        identifier = f"{plan_id}::{model}"
        point = points.get(identifier, {})
        baseline = baselines.get(model)
        monthly_tokens = int(adopted_row["monthly_tokens"]) if adopted_row["monthly_tokens"] else None
        monthly_usd = None
        if adopted_row["billing"] == "subscription":
            local_price = decimal(adopted_row["price"])
            monthly_usd = local_price / fx if adopted_row["currency"] == "CNY" else local_price
        if monthly_tokens and monthly_usd is not None:
            real_price = monthly_usd * 1_000_000 / monthly_tokens
            real_calculation = "monthly_usd * 1e6 / monthly_tokens"
        elif plan_id in metered_by_id:
            real_price = blended(metered_components(metered_by_id[plan_id]))
            real_calculation = "cache * .975 + input * .0215 + output * .0035"
        else:
            real_price = decimal(adopted_row["real_usd_per_mtok"]) if adopted_row["real_usd_per_mtok"] else None
            real_calculation = "source_value"
        warnings = []
        if adopted_row["billing"] == "subscription":
            warnings.append("Оценка при полном использовании квоты; effort измерения квоты не подтверждён.")
        if model == "mimo-v2.5-pro":
            warnings.append("Базовая API-цена RAP использует overseas 0.2/1/3; квоты подписок рассчитаны по другим тарифам канала. Это разные ценовые источники, они не объединены.")
        if model == "deepseek-v4-flash":
            warnings.append("Точное соответствие снимку 0731 подтверждено data/official-api-prices.json.")
        rows.append({
            "id": identifier,
            "model": model,
            "model_display": MODELS[model],
            "plan_id": plan_id,
            "plan": adopted_row.get("plan_name_en") or adopted_row["plan_name"],
            "billing": adopted_row["billing"],
            "model_provider": point.get("vendor") or model_providers.get(model) or MODEL_PROVIDER_FALLBACK.get(model, "Не указан"),
            "access_channel": access_channel(plan_id, adopted_row["billing"]),
            "is_api_baseline": adopted_row["billing"] == "metered" and bool(baseline) and plan_id == baseline["plan_id"],
            "monthly_usd": float(monthly_usd) if monthly_usd is not None else None,
            "monthly_usd_source_rounded": float(adopted_row["price_usd"]) if adopted_row["price_usd"] else None,
            "monthly_tokens": monthly_tokens,
            "real_price_usd_per_million": float(real_price) if real_price is not None else None,
            "real_price_source_rounded": float(adopted_row["real_usd_per_mtok"]) if adopted_row["real_usd_per_mtok"] else None,
            "real_price_calculation": real_calculation,
            "api_price_usd_per_million": float(baseline["price"]) if baseline else None,
            "coefficient": float(real_price / baseline["price"]) if real_price is not None and baseline else None,
            "api_price_components": baseline["components"] if baseline else None,
            "api_baseline_kind": baseline["kind"] if baseline else None,
            "api_baseline_plan_id": baseline["plan_id"] if baseline else None,
            "api_source": baseline["source"] if baseline else None,
            "api_source_url": baseline["source_url"] if baseline else None,
            "confidence": adopted_row["confidence"],
            "source": adopted_row["source"],
            "source_url": f"https://github.com/{REPOSITORY}/blob/{revision}/data/adopted.csv",
            "note": adopted_row["decision_note"],
            "workload": adopted_row.get("workload") or point.get("workload"),
            "quota_effort": None,
            "warnings": warnings,
        })

    # Добавляем явную API-базу там, где RAP не опубликовал отдельную metered-строку.
    for model, baseline in baselines.items():
        if any(row["model"] == model and row["billing"] == "metered" for row in rows):
            continue
        rows.append({
            "id": f"api_reference::{model}",
            "model": model,
            "model_display": MODELS[model],
            "plan_id": "api_reference",
            "plan": "API (базовая цена)",
            "billing": "metered",
            "model_provider": model_providers.get(model) or MODEL_PROVIDER_FALLBACK.get(model, "Не указан"),
            "access_channel": "API",
            "is_api_baseline": True,
            "monthly_usd": None,
            "monthly_tokens": None,
            "real_price_usd_per_million": float(baseline["price"]),
            "api_price_usd_per_million": float(baseline["price"]),
            "coefficient": 1.0,
            "api_price_components": baseline["components"],
            "api_baseline_kind": baseline["kind"],
            "api_baseline_plan_id": None,
            "api_source": baseline["source"],
            "api_source_url": baseline["source_url"],
            "confidence": "source_reference",
            "source": baseline["source"],
            "source_url": baseline["source_url"],
            "note": "API-база рассчитана из трёх исходных ставок; отдельной строки тарифа в adopted.csv нет.",
            "workload": "standard_mix",
            "quota_effort": None,
            "warnings": [],
        })

    coverage = []
    for model, label in MODELS.items():
        model_rows = [row for row in rows if row["model"] == model]
        coverage.append({
            "model": model,
            "model_display": label,
            "subscription_rows": sum(row["billing"] == "subscription" for row in model_rows),
            "api_rows": sum(row["billing"] == "metered" for row in model_rows),
            "api_baseline_available": model in baselines,
            "status": "ok" if any(row["billing"] == "subscription" for row in model_rows) else "no_subscription_data",
        })

    hashes = {path: hashlib.sha256(raw_path(path).read_bytes()).hexdigest() for path in FILES}
    if aa_path.exists():
        hashes["../aa/aa.json"] = hashlib.sha256(aa_path.read_bytes()).hexdigest()
    generated_at = datetime.now(timezone.utc).isoformat()
    previous_path = OUT / "pricing.json"
    retrieved_at = generated_at
    if not refresh and previous_path.exists():
        retrieved_at = read_json(previous_path).get("retrieved_at_utc", generated_at)
    result = {
        "schema_version": 1,
        "retrieved_at_utc": retrieved_at,
        "generated_at_utc": generated_at,
        "repository": f"https://github.com/{REPOSITORY}",
        "revision": revision,
        "revision_date": commit["commit"]["committer"]["date"],
        "conventions_updated_at": conventions["updatedAt"],
        "source_points_generated_at": source_points.get("generatedAt"),
        "standard_token_mix": {key: float(value) for key, value in mixture.items()},
        "formula": "scaled_aa_cost = aa_cost * real_price_usd_per_million / api_price_usd_per_million",
        "precision_note": "Цены вычислены без дополнительного округления из опубликованных квот и ставок. Сами исходные квоты являются округлёнными оценками.",
        "effort_note": "Один коэффициент модели и тарифа применяется ко всем AA effort; это сценарная оценка, а не отдельное измерение подписки для каждого effort.",
        "api_baseline_policy": "Базовый тариф RAP из METERED; для DeepSeek — peak. При отсутствии — exact list price RAP, затем exact API-ставки AA со смесью RAP. Разные модели не подставляются.",
        "snapshot_aliases": {"deepseek-v4-flash": "DeepSeek-V4-Flash-0731"},
        "source_sha256": hashes,
        "coverage": coverage,
        "rows": rows,
    }
    save_json(OUT / "pricing.json", result)
    save_json(OUT / "coverage.json", coverage)
    print(json.dumps({"rows": len(rows), "subscription_rows": sum(row["billing"] == "subscription" for row in rows), "api_rows": sum(row["billing"] == "metered" for row in rows), "missing_baselines": [item["model"] for item in coverage if not item["api_baseline_available"]]}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Загрузить свежий фиксированный снимок из GitHub")
    normalize(parser.parse_args().refresh)
