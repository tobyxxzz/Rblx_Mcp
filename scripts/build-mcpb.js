// Gera dist/rblx-mcp.mcpb (zip de mcpb/ + manifest.json).
// Uso: npm run build:mcpb
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "mcpb");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(DIST, "rblx-mcp.mcpb");

function fail(msg) {
  console.error(`Erro: ${msg}`);
  process.exit(1);
}

// 1) valida manifest
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
} catch (e) {
  fail(`manifest.json inválido: ${e.message}`);
}
for (const k of ["manifest_version", "name", "version", "description", "author", "server"]) {
  if (!manifest[k]) fail(`manifest.json sem campo obrigatório: ${k}`);
}
if (!manifest.author || !manifest.author.name) fail("manifest.json: author.name obrigatório");
const entry = path.join(SRC, manifest.server.entry_point || "");
if (!fs.existsSync(entry)) fail(`entry_point não encontrado: ${manifest.server.entry_point}`);

// 2) checa sintaxe do proxy
try {
  execSync(`node --check "${entry}"`, { stdio: "ignore" });
} catch {
  fail("proxy.js com erro de sintaxe (node --check)");
}

// 3) zipa SÓ o conteúdo do bundle (manifest + server).
// Ignora qualquer outra coisa dentro de mcpb/ (ex: clone local do repo).
fs.mkdirSync(DIST, { recursive: true });
try {
  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
  if (process.platform === "win32") {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${SRC}\\manifest.json','${SRC}\\server' -DestinationPath '${OUT}' -Force"`,
      { stdio: "inherit" }
    );
  } else {
    execSync(`zip -r "${OUT}" manifest.json server`, { cwd: SRC, stdio: "inherit" });
  }
} catch {
  fail("ferramenta de zip ausente (Windows: PowerShell 5+; mac/Linux: pacote zip)");
}

const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`✓ ${OUT} (${kb} KB) — abra com o Claude Desktop p/ instalar`);
