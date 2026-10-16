---
root: true
targets: ["codexcli", "claudecode", "opencode", "cursor"]
description: "Защищает project-local правила и generated outputs Rulesync"
cursor:
  alwaysApply: true
  description: "Защищает project-local правила и generated outputs Rulesync"
  globs: ["**/*"]
---

# Владение project-local правилами Rulesync

Единственный canonical source project-local AI rules — `<project>\.rulesync\rules`.

`AGENTS.md`, `CLAUDE.md`, Rulesync-generated target files Cursor, OpenCode и Codex, а также другие outputs команды `rulesync generate` нельзя редактировать вручную, если конкретным файлом владеет Rulesync. Прямые изменения таких generated outputs будут перезаписаны следующей генерацией.

Чтобы добавить или изменить project rule, редактируй `.rulesync\rules\*.md`, затем запускай `rulesync generate` из корня проекта и проверяй generated diff.

Это правило относится только к файлам, которыми фактически владеет текущая project-local конфигурация Rulesync. Оно не объявляет generated-файлом произвольный `AGENTS.md`, который проект поддерживает вручную и который Rulesync не создаёт или не обновляет.
