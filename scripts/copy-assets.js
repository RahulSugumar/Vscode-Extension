/* eslint-disable */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const viewerOut = path.join(distDir, "viewer", "webview");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copy(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyGlobWasm(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  for (const f of fs.readdirSync(srcDir)) {
    if (f.endsWith(".wasm")) copy(path.join(srcDir, f), path.join(destDir, f));
  }
}

// 1) Tree-sitter core wasm (loaded by Parser.init).
copy(
  path.join(root, "node_modules", "web-tree-sitter", "tree-sitter.wasm"),
  path.join(distDir, "tree-sitter.wasm"),
);

// 2) Language wasms (Python, JS, TS, TSX).
copyGlobWasm(
  path.join(root, "node_modules", "tree-sitter-wasms", "out"),
  distDir,
);

// 3) Cytoscape + fcose dependency chain (script order matters at runtime).
copy(
  path.join(root, "node_modules", "cytoscape", "dist", "cytoscape.min.js"),
  path.join(viewerOut, "cytoscape.min.js"),
);
copy(
  path.join(root, "node_modules", "layout-base", "layout-base.js"),
  path.join(viewerOut, "layout-base.js"),
);
copy(
  path.join(root, "node_modules", "cose-base", "cose-base.js"),
  path.join(viewerOut, "cose-base.js"),
);
copy(
  path.join(root, "node_modules", "cytoscape-fcose", "cytoscape-fcose.js"),
  path.join(viewerOut, "cytoscape-fcose.js"),
);

// 4) Our own webview HTML/JS (kept under src/ so it's editable; copied at build).
const srcViewer = path.join(root, "src", "viewer", "webview");
if (fs.existsSync(srcViewer)) {
  for (const f of fs.readdirSync(srcViewer)) {
    copy(path.join(srcViewer, f), path.join(viewerOut, f));
  }
}
