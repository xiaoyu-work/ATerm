# ATerm

ATerm.

AI Terminal. Agentic Terminal. AT Terminal. A Terminal.

A modern terminal with a built-in AI agent assistant.
Claude Code, Codex, Copilot CLI — built right into your terminal.
Type `@` and talk to AI directly from your command line.

*Talk to AI directly from your command line*
![ATerm Screenshot](assets/screenshot.png)

*AI agent that executes commands, edits files, and manages tasks for you*
![AI Agent](assets/ai-screenshot.png)

## Features

- **Built-in AI Agent** — Type `@` to talk to AI directly from your command line. Execute commands, edit files, search the web, and manage tasks through natural language.
- **Modern Terminal** — GPU-accelerated rendering, ligature support, image display, and tabs.
- **SSH & Connections** — Native SSH client powered by Rust, serial port, telnet, and socket connections.
- **Cross-Platform** — Native apps for Windows, macOS, and Linux.
- **Secure & Private** — API keys stay local. Supports any OpenAI-compatible endpoint.
- **Extensible** — Modular plugin architecture with color schemes, shell integrations, and more.

## Development

### Prerequisites

- Node.js
- Yarn 4 (configured via `packageManager` in `package.json`)

### Install dependencies

```bash
yarn install
```

### Build

```bash
yarn build
```

### Start dev

Start webpack watch mode and Electron in two separate terminals:

```bash
# Terminal 1 - webpack watch mode
yarn watch

# Terminal 2 - start Electron app
yarn start
```

## License

MIT - see [LICENSE](LICENSE) for details.

Based on [Tabby](https://github.com/Eugeny/tabby) by Eugeny and contributors.
