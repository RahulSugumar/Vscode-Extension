# Project Assistant

Project Assistant is a VS Code extension that scans an opened workspace into an interactive code graph, starts a local FastAPI backend, and gives you a project-aware assistant inside the editor.

It is built for codebase exploration, graph-backed chat, and lightweight agent-improvement workflows. The extension can parse source files, enrich the graph with language-server resolution, sync graph data to Neo4j, and surface policy suggestions that help tune an assistant over time.

## Highlights

- Scan a workspace into a `.code-knowledge-graph.json` file.
- View the graph in a Cytoscape-powered Project Graph panel.
- Ask project-context questions from the VS Code sidebar or full editor view.
- Sync graph data to Neo4j for retrieval-backed answers.
- Review, add, replace, or discard assistant policy suggestions in the Improve view.
- Keep graph artifacts fresh with incremental updates after file changes.
- Store runtime secrets with VS Code SecretStorage.

## Requirements

- VS Code `1.90.0` or newer.
- Node.js and npm for extension development.
- Python available as `python` or `python3`, unless `selfEvolvingAgent.backend.pythonPath` points to a specific interpreter.
- Neo4j only when GraphRAG chat is required. Local graph scanning and visualization do not require it.
- An OpenAI API key only when chat is required with the `openai` provider.

On first backend startup, the extension prefers `backend/.venv` when it exists. Otherwise it creates a managed virtual environment in VS Code global storage and installs `backend/requirements.txt`. A requirements hash prevents dependency installation from being repeated on the first chat request.

## Supported Source Files

The scanner currently tracks:

- Python: `.py`
- JavaScript and TypeScript: `.js`, `.jsx`, `.ts`, `.tsx`
- Java: `.java`
- C#: `.cs`
- C and C++: `.c`, `.h`, `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx`
- Rust: `.rs`
- Go: `.go`

Generated and dependency folders such as `node_modules`, `dist`, `build`, `.git`, `venv`, and `.venv` are ignored.

## Using the Extension

1. Open a workspace folder in VS Code.
2. Open Project Assistant from the activity bar or run `Project Assistant: Open Project Assistant`.
3. Save the optional setup values. The backend and local graph work without OpenAI or Neo4j.
4. Let the initial Project Graph scan finish.
5. Use the main views:

| View | Purpose |
| --- | --- |
| Ask | Chat with the project-aware assistant. |
| Graph | Scan the workspace, open the Project Graph, and filter relationships. |
| Improve | Review suggested assistant policies or submit custom policies. |
| History | Manage local chat session entries. |
| Settings | Update Neo4j, LLM, model, and secret values. |

## Commands

| Command | What it does |
| --- | --- |
| `Project Assistant: Open Project Assistant` | Opens the React assistant UI in an editor tab. |
| `Project Assistant: Scan Project` | Starts or resumes project graph creation. |
| `Project Assistant: Open Project Graph` | Opens the standalone graph viewer for the saved graph. |
| `Project Assistant: Ask` | Switches the assistant UI to the Ask view. |
| `Project Assistant: Graph` | Switches the assistant UI to the Graph view. |
| `Project Assistant: Improve` | Switches the assistant UI to the Improve view. |
| `Project Assistant: Reset Workspace State (Debug)` | Clears stored workspace UI state for debugging. |

## Runtime Configuration

Most users should configure these from the Project Assistant setup screen. The same values are also exposed as VS Code settings.

| Setting | Default | Notes |
| --- | --- | --- |
| `selfEvolvingAgent.neo4j.uri` | `bolt://localhost:7687` | Neo4j Bolt URI. |
| `selfEvolvingAgent.neo4j.user` | `neo4j` | Neo4j username. |
| `selfEvolvingAgent.neo4j.database` | `neo4j` | Neo4j database used for graph seeding and retrieval. |
| `selfEvolvingAgent.llm.provider` | `openai` | Supported values are `openai` and `local`. |
| `selfEvolvingAgent.llm.model` | `gpt-4o-mini` | Main assistant model. |
| `selfEvolvingAgent.backend.pythonPath` | empty | Optional absolute Python interpreter path. |
| `selfEvolvingAgent.backend.baseUrl` | `http://localhost:8000` | Updated automatically when the managed backend starts. |
| `selfEvolvingAgent.telemetry.enabled` | `true` | Writes redacted agent telemetry to local workspace storage. |
| `selfEvolvingAgent.telemetry.externalJudgeEnabled` | `false` | Allows the background judge to send redacted telemetry to the configured external LLM. |
| `selfEvolvingAgent.graph.jsonFileName` | `.code-knowledge-graph.json` | Workspace graph artifact name. |
| `selfEvolvingAgent.graph.incrementalUpdates` | `true` | Patches graph data after tracked source changes. |
| `selfEvolvingAgent.graph.useLsp` | `true` | Uses language servers for cross-file calls, imports, and inheritance. |
| `selfEvolvingAgent.useMockBackend` | `false` | Uses mock responses for offline UI work when enabled. |

Neo4j passwords and OpenAI API keys entered through the setup screen are stored in VS Code SecretStorage. They are not written to `settings.json` or returned to the webview. Stored credentials are represented by an empty password field with a saved-value placeholder.

Without complete chat settings, graph artifacts remain local and are not uploaded to Neo4j. When the required OpenAI and Neo4j settings become available, the latest local graph is synchronized before setup completes.

## Graph Artifacts

Project Assistant writes these files in the workspace root:

- `.code-knowledge-graph.json`: exported nodes and relationships.
- `.code-knowledge-graph.ledger.json`: incremental update ledger.

The graph contains folder, file, class, method, function, and interface nodes. Relationships include containment, calls, imports, inheritance, implementation, instantiation, and deeper dependency links where semantic resolution is available.

## Development Setup

Install the root extension dependencies:

```powershell
npm install
```

Install the React webview dependencies:

```powershell
cd webview
npm install
cd ..
```

Optional backend virtual environment:

```powershell
python -m venv backend/.venv
backend/.venv/Scripts/python -m pip install -r backend/requirements.txt
```

Build everything needed by the extension:

```powershell
npm run build
```

During development, common scripts are:

| Script | Purpose |
| --- | --- |
| `npm run compile` | Type-check and compile the VS Code extension host. |
| `npm run watch` | Watch TypeScript extension host files. |
| `npm run build:webview` | Build the Vite React webview. |
| `npm run dev:webview` | Start the webview Vite dev server. |
| `npm run copy-assets` | Copy Tree-sitter and graph-viewer assets into `dist`. |
| `npm run build` | Compile extension code, copy assets, and build the webview. |
| `npm run package:vsix` | Build and package a VSIX with `@vscode/vsce`. |

To debug the extension, open this folder in VS Code, run the Extension Development Host, and then open a real workspace folder in the launched window.

For repeatable no-key testing, Development-mode activation deletes the workspace-scoped OpenAI key from SecretStorage. Installed and packaged extensions do not delete stored keys on activation.

## Backend

The backend entry point is `backend/main.py`. It mounts three areas:

- Agent Improvement Plane routes under `/admin`.
- Codebase chatbot routes under `/chatbot`.
- GraphRAG graph seed, retrieve, chat, and patch routes under `/graphrag`.

For direct backend testing, pass environment variables for Neo4j, model provider, model name, and API keys. Do not keep real secrets in `backend/.env`. The extension normally supplies secrets from VS Code SecretStorage through the backend process environment and updates them through its private child-process channel.

Health check:

```powershell
python backend/main.py
```

All backend routes require the per-process bearer token generated by the extension. Direct development launches must set `BACKEND_AUTH_TOKEN` and provide it in the `Authorization` header.

## Packaging

Create a VSIX:

```powershell
npm run package:vsix
```

The VS Code extension page uses both this README and the marketplace metadata in `package.json`, including display name, description, categories, keywords, repository, homepage, and gallery banner.

Before publishing to the Marketplace, confirm that `publisher` in `package.json` matches the VS Code Marketplace publisher ID that owns the release token.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Webview says assets are missing | Run `npm run build:webview`, then reload the Extension Development Host. |
| Backend fails with missing Python modules | Install `backend/requirements.txt` into `backend/.venv` or let the extension create its managed venv. |
| Neo4j setup fails | Confirm URI, username, password, and database, then test that Neo4j accepts `RETURN 1`. |
| Chat starts but has no graph context | Run `Project Assistant: Scan Project` and wait for the Neo4j sync to finish. |
| Semantic links are sparse | Install the suggested language-server extensions and keep `selfEvolvingAgent.graph.useLsp` enabled. |

## License

This project is currently marked `UNLICENSED` in `package.json`.
