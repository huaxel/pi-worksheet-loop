# Pi Worksheet Loop

A Pi extension for Markdown-first collaboration: saved worksheet revisions steer Pi, while the document remains the durable home for plans, findings, decisions, and progress.

## Install

Install from the terminal (or `pi install ./pi-worksheet-loop` for a local path):

```bash
pi install npm:@juanbenjumea/pi-worksheet-loop
```

The package is self-contained: Pi discovers the extension via the `pi.extensions` manifest entry and the root `SKILL.md` as a native skill. Note: if you also keep a separately installed `worksheet-loop` skill, the first-loaded copy wins the name and the other is reported as a collision diagnostic.

For one-off development, load the source without installing:

```bash
pi -e /path/to/pi-worksheet-loop/index.ts
```

## Commands

- `/worksheet start <slug>` — create and select a project worksheet
- `/worksheet attach <path>` — select/watch an existing Markdown file
- `/worksheet list` and `/worksheet search <text>` — discover project worksheets
- `/worksheet open [name]` — select and open a worksheet
- `/worksheet status`, `/worksheet pause`, `/worksheet resume`
- `/worksheet mode on|off` — toggle document-first response routing

The extension creates project-local `.worksheets/ws-<epoch>-<id>-<slug>.md` files (timestamp + short random id, so parallel sessions never collide). Select a worksheet explicitly for each Pi session; sessions do not implicitly attach to the newest worksheet.

The collaboration contract and detailed behavior are in [SKILL.md](SKILL.md). Design and implementation notes are retained in the companion documents.

## Development

```sh
npm install
npm test        # behavioral tests for the pure core (Node >= 22.7)
npm run typecheck  # strict tsc --noEmit against the pi SDK types
```

The current extension source originated in the dotfiles workspace and had a `.disabled` suffix there to prevent Pi discovery during development. This package exposes the source as `index.ts` for standalone installation.
