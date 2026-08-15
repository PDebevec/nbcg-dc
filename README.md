# NBCG-DC

Desktop helper for the **National Library of Montenegro** (Nacionalna biblioteka
Crne Gore). Library staff scan material into folders; this app processes each
folder (PDF · thumbnail · OCR), collects its metadata, and uploads it to the
`nbcg` backend — replacing a hand-typed JSON/XML workflow.

Vue 3 + Tauri 2, with Python scripts doing the heavy file work.

## Getting started

```bash
npm install
npm run tauri dev
```

## Testing build
```bash
npm run build
npm run preview
```

**`npm run tauri dev` requires Rust and VS Build Tools** — see
[docs/06 – Native core & developer setup](docs/06-native-core-and-dev-setup.md)
for why, and for what you can do without them.

`npm run dev` runs the frontend alone in a browser. It renders the whole UI but
has no native side, so it shows no items and persists nothing — fine for styling
work, misleading for anything else.

## Documentation

Read in order:

| Doc | What it covers |
|---|---|
| [00 – Project overview](docs/00-project-overview.md) | What this is and the problem it solves |
| [01 – Concept & UX](docs/01-concept-and-ux.md) | The batch-centric design |
| [02 – Architecture](docs/02-architecture.md) | Connection model, local storage, pipeline |
| [03 – Open questions](docs/03-open-questions.md) | Decisions and their reasoning |
| [04 – Code structure](docs/04-code-structure.md) | The three lanes and four seams |
| [05 – Real scan data](docs/05-real-scan-data.md) | Measured from actual scanner output |
| [06 – Native core & dev setup](docs/06-native-core-and-dev-setup.md) | What `src-tauri/` does; toolchain requirements |
| [PROJECT-KNOWLEDGE](docs/PROJECT-KNOWLEDGE.md) | The verified backend contract |
| [tasks/](docs/tasks/README.md) | The epic roadmap |

## Layout

```
src/          Vue 3 frontend — .vue/.css (GUI lane), .ts (logic lane)
src-tauri/    Rust native core — SQLite index, filesystem, config
py/           Python pipeline scripts — OCR, PDF, thumbnails
docs/         Design docs and the epic roadmap
```

Ownership is split by file type across three lanes — see
[04 – Code structure](docs/04-code-structure.md).

## Tests

```bash
npm test                      # 618 frontend tests
cd src-tauri && cargo test    # 73 native tests
```

## Recommended IDE setup

[VS Code](https://code.visualstudio.com/) +
[Vue - Official](https://marketplace.visualstudio.com/items?itemName=Vue.volar) +
[Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) +
[rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
