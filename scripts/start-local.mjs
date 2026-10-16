import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const webDir = fileURLToPath(new URL("../web/", import.meta.url));
const origin = "http://127.0.0.1:8766";
const url = `${origin}/#lang=en&board=aa_combined&billing=metered&billing=subscription`;

function run(command, args, shell = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: webDir, stdio: "inherit", shell });
    const interrupt = () => child.kill("SIGINT");
    process.once("SIGINT", interrupt);
    child.once("error", (error) => {
      process.removeListener("SIGINT", interrupt);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", interrupt);
      if (code === 0 || signal === "SIGINT") resolve();
      else reject(new Error(`Команда ${command} завершилась с кодом ${code ?? signal}.`));
    });
  });
}

async function main() {
  const response = await fetch(origin, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  if (response) {
    const html = await response.text();
    const data = await fetch(`${origin}/data/aa-costs.json`, { signal: AbortSignal.timeout(10000) })
      .then((result) => result.json()).catch(() => null);
    if (response.ok && html.includes("Real API Pricing") && Array.isArray(data?.quota_scenario?.rows)) {
      console.log(`Сайт уже запущен. Откройте:\n${url}`);
      return;
    }
    throw new Error("Порт 8766 занят другим приложением. Освободите его и повторите запуск.");
  }

  const viteCli = join(webDir, "node_modules/vite/bin/vite.js");
  if (!existsSync(viteCli)) {
    console.log("Устанавливаю зависимости сайта из package-lock.json…");
    const windows = process.platform === "win32";
    await run(windows ? "npm.cmd" : "npm", ["ci"], windows);
  }

  console.log("Подготавливаю сохранённые данные RAP и AA…");
  await run(process.execPath, ["scripts/build-data.mjs"]);
  await run(process.execPath, ["scripts/build-aa-data.mjs"]);
  console.log(`Откройте вкладку AA Task Cost:\n${url}\nДля остановки нажмите Ctrl+C.`);
  await run(process.execPath, [viteCli, "--host", "127.0.0.1", "--port", "8766", "--strictPort"]);
}

main().catch((error) => {
  console.error(`Не удалось запустить сайт: ${error.message}`);
  process.exitCode = 1;
});
