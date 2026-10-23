// src/index.ts
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

// ../extension/src/core/jsonLine.ts
function lastJsonObject(stdout, accept = () => true) {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line);
      if (typeof value === "object" && value !== null && accept(value)) {
        return value;
      }
    } catch {
      continue;
    }
  }
  return void 0;
}

// ../extension/src/core/tool.ts
var WEIGHTING_TYPES = ["disable", "linear", "exponential", "inverse"];
var DEFAULT_WINDOW_YEARS = 2;
function toolArgs(request) {
  const args = ["--ecosystem", request.ecosystem, "--package", request.packageName, "--json"];
  if (request.dataSource === "depsdev") args.push("--depsdev");
  args.push("--start-date", request.startDate, "--end-date", request.endDate);
  args.push("--weighting-type", request.weightingType);
  if (request.halfLife !== null) args.push("--half-life", String(request.halfLife));
  args.push("--output-dir", request.outputDir);
  return args;
}
function windowStartDate(today, years = DEFAULT_WINDOW_YEARS) {
  const year = today.getFullYear() - years;
  const month = today.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  return formatDate(new Date(year, month, Math.min(today.getDate(), lastDay)));
}
function formatDate(time) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
}
function parseToolOutput(output) {
  const result = lastJsonObject(output.stdout);
  if (result) return { kind: "result", result };
  const lastLine2 = output.stderr.trim().split(/\r?\n/).pop()?.trim();
  return {
    kind: "failed",
    message: lastLine2 || `the Tool printed no result (exit code ${output.exitCode})`
  };
}

// ../extension/src/spawnProcess.ts
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
function spawnProcess(file, args, options = {}) {
  return new Promise((resolve2) => {
    const child = spawn(file, args, {
      signal: options.signal,
      windowsHide: true,
      env: { ...process.env, ...options.env, PYTHONIOENCODING: "utf-8" }
    });
    const stdout = [];
    const stderr = [];
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let error;
    let timedOut = false;
    let done = false;
    const emitLines = (text, flush) => {
      if (!options.onStderrLine) return;
      const parts = (pending + text).split(/[\r\n]/);
      pending = flush ? "" : parts.pop() ?? "";
      for (const line of parts) if (line !== "") options.onStderrLine(line);
    };
    const finish = (exitCode, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      emitLines(decoder.end(), true);
      resolve2({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        error,
        timedOut
      });
    };
    const timer = options.timeoutMs === void 0 ? void 0 : setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
      emitLines(decoder.write(chunk), false);
    });
    child.on("error", (err) => {
      error = err.message;
      if (child.pid === void 0) finish(null, null);
    });
    child.on("close", (exitCode, signal) => finish(exitCode, signal));
  });
}

// ../extension/src/processToolRunner.ts
function toolCommand(toolPath) {
  const file = toolPath.trim();
  if (file === "") return { file: "dependency-metrics", args: [] };
  if (/\.(?:mjs|cjs|js)$/i.test(file)) {
    return { file: process.execPath, args: [file], env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { file, args: [] };
}
function runToolCommand(command2, toolArgs2, options = {}) {
  return spawnProcess(command2.file, [...command2.args, ...toolArgs2], {
    ...options,
    env: { ...command2.env, ...options.env }
  });
}

// image.json
var image_default = {
  repository: "ghcr.io/imranur-rahman/mttx",
  version: "0.2.1",
  osvTag: "0.2.1-osv-2026-10-23",
  digest: "sha256:c9b79473d3ddfb5edf6b903770d3fffa678333bd64cada8be0aa7b9733fa2586",
  osvDigest: "sha256:3d528b998884f985e484b1da0cceb1219930c1d38625e18bb9ed9f69bce5c2eb"
};

// src/docker.ts
var IMAGE_OUTPUT_DIR = "/data";
function imageReference(image, osvIndex) {
  const [tag, digest] = osvIndex === "image" ? [image.osvTag ?? image.version, image.osvDigest] : [image.version, image.digest];
  return `${image.repository}:${tag}${digest ? `@${digest}` : ""}`;
}
function dockerRunArgs(image, mount) {
  return [
    "run",
    "--rm",
    "--init",
    "-v",
    `${mount.hostDir}:${IMAGE_OUTPUT_DIR}`,
    "--user",
    `${mount.uid}:${mount.gid}`,
    "-e",
    "HOME=/tmp",
    image
  ];
}
function dockerTool(image, mount) {
  const prefix = dockerRunArgs(image, mount);
  return (args, timeoutMs) => spawnProcess("docker", [...prefix, ...args], timeoutMs === void 0 ? {} : { timeoutMs });
}

// ../extension/src/core/discovery.ts
var MANIFEST_NAMES = ["package.json", "pyproject.toml", "Cargo.toml"];
var SKIPPED_FOLDERS = ["node_modules", ".venv"];
var MANIFEST_PATTERN = `**/{${MANIFEST_NAMES.join(",")}}`;
function isAnalyzedManifest(path) {
  const parts = path.split(/[\\/]/);
  const name = parts.pop() ?? "";
  if (!MANIFEST_NAMES.includes(name)) return false;
  return !parts.some((part) => SKIPPED_FOLDERS.includes(part));
}

// src/github.ts
async function git(cwd, args) {
  const result = await spawnProcess("git", ["-C", cwd, ...args]);
  return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr.trim() || result.error || "" };
}
async function gitManifestChanges(cwd, baseSha, headSha) {
  const mergeBase = await git(cwd, ["merge-base", baseSha, headSha]);
  if (!mergeBase.ok) {
    throw new Error(
      `git cannot find the merge base of ${baseSha} and ${headSha} (${mergeBase.stderr}). Check out the full history: actions/checkout with fetch-depth: 0.`
    );
  }
  const base = mergeBase.stdout.trim();
  const diff = await git(cwd, ["diff", "--name-status", "-z", "-M", base, headSha]);
  if (!diff.ok) throw new Error(`git diff failed: ${diff.stderr}`);
  const fields = diff.stdout.split("\0").filter((field) => field !== "");
  const changes = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    const oldPath = fields[index++];
    const path = /^[RC]/.test(status) ? fields[index++] : oldPath;
    if (!isAnalyzedManifest(path)) continue;
    changes.push({ path, base: await fileAt(cwd, base, oldPath), head: await fileAt(cwd, headSha, path) });
  }
  return changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
async function fileAt(cwd, commit, path) {
  const result = await git(cwd, ["show", `${commit}:${path}`]);
  return result.ok ? result.stdout : null;
}
function restCommentStore(options) {
  const doFetch = options.fetch ?? fetch;
  const base = `${options.apiUrl.replace(/\/$/, "")}/repos/${options.repository}`;
  const request = async (method, url, body) => {
    const response = await doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...body === void 0 ? {} : { "content-type": "application/json" }
      },
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${response.status} ${json.message ?? response.statusText}`);
    return json;
  };
  const comment = (json) => {
    const value = json;
    return { id: value.id, body: value.body ?? "", url: value.html_url };
  };
  return {
    async list() {
      const comments = [];
      for (let page = 1; ; page++) {
        const items = await request("GET", `${base}/issues/${options.number}/comments?per_page=100&page=${page}`);
        comments.push(...items.map(comment));
        if (items.length < 100) return comments;
      }
    },
    async create(body) {
      return comment(await request("POST", `${base}/issues/${options.number}/comments`, { body }));
    },
    async update(id, body) {
      return comment(await request("PATCH", `${base}/issues/comments/${id}`, { body }));
    }
  };
}

// ../extension/src/core/osvIndex.ts
var OSV_DOWNLOAD_SIZE = "about 260 MB";
var OSV_PROMPT = {
  message: `MTTX needs the OSV index to compute MTTR. The download is ${OSV_DOWNLOAD_SIZE}. Without the index, the hints show MTTU only.`,
  build: "Download the OSV index",
  decline: "Not now"
};
function osvIndexDateArgs(outputDir) {
  return ["--osv-index-date", "--output-dir", outputDir];
}
function buildOsvArgs(outputDir) {
  return ["--build-osv", "--output-dir", outputDir];
}
function parseOsvIndexDate(stdout) {
  const date = lastJsonObject(stdout, (value) => "osv_index_date" in value)?.osv_index_date;
  if (date === null) return { kind: "missing" };
  return typeof date === "string" ? { kind: "built", date } : void 0;
}

// ../webapp/site/static/js/comparison.js
var NO_VALUE = "\u2013";
function hasNoDependencies(entry) {
  return entry?.status === "no_deps" || entry?.status === "ok" && entry.num_dependencies === 0;
}
function hasValue(entry) {
  return metricValue(entry, "mttu") !== null && metricValue(entry, "mttr") !== null;
}
function metricValue(entry, metric) {
  if (entry?.status !== "ok" || hasNoDependencies(entry)) return null;
  return typeof entry[metric] === "number" ? entry[metric] : null;
}
var MAX_PACKAGES = 5;
function cleanPackages(packages) {
  return packages.map((name) => name.trim()).filter((name) => name !== "");
}
function packageKey(ecosystem, name) {
  const key = name.trim().toLowerCase();
  return ecosystem === "pypi" ? key.replace(/[-_.]+/g, "-") : key;
}
var ECOSYSTEM_LABELS = { npm: "npm", pypi: "PyPI", cargo: "Cargo" };
var PACKAGE_NAME_RULES = {
  npm: { pattern: /^(@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/, maxLength: 214 },
  pypi: { pattern: /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/, maxLength: Infinity },
  cargo: { pattern: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/, maxLength: 64 }
};
function packageNameMatchesRules(ecosystem, name) {
  const rule = PACKAGE_NAME_RULES[ecosystem];
  if (rule === void 0) return false;
  return name.length <= rule.maxLength && rule.pattern.test(name);
}
function packageErrors(ecosystem, packages) {
  const names = cleanPackages(packages);
  if (names.length === 0) return ["Enter at least one package."];
  if (names.length > MAX_PACKAGES) return [`Enter at most ${MAX_PACKAGES} packages.`];
  const seen = /* @__PURE__ */ new Set();
  const errors = [];
  for (const name of names) {
    if (!packageNameMatchesRules(ecosystem, name)) {
      errors.push(`${name} is not a valid ${ECOSYSTEM_LABELS[ecosystem] ?? ecosystem} package name.`);
      continue;
    }
    const key = packageKey(ecosystem, name);
    if (seen.has(key)) errors.push(`${name} is in the Comparison twice.`);
    seen.add(key);
  }
  return errors;
}
var NO_WEIGHTING = "disable";
var EXPONENTIAL = "exponential";
var MIN_HALF_LIFE_DAYS = 1;
var MAX_HALF_LIFE_DAYS = 3650;
var FINAL_STATES = ["done", "error", "cancelled"];
var JOB_EVENTS = ["queued", "running", ...FINAL_STATES];
var TABLE_COLUMNS = [
  ["package", "Package"],
  ["mttu", "MTTU (days)"],
  ["mttr", "MTTR (days)"],
  ["dependencies", "Dependencies"],
  ["error", "Error"]
];
var PER_RELEASE_COLUMNS = [
  TABLE_COLUMNS[0],
  ["version", "Version"],
  ["releaseDate", "Release date"],
  ...TABLE_COLUMNS.slice(1)
];
function formatDays(days) {
  return typeof days === "number" ? days.toFixed(2) : NO_VALUE;
}
function needsHalfLife(weightingType) {
  return weightingType === EXPONENTIAL;
}
function halfLifeError(weightingType, halfLife) {
  if (!needsHalfLife(weightingType)) return null;
  const text = String(halfLife ?? "").trim();
  const days = Number(text);
  if (text === "" || !Number.isFinite(days) || days < MIN_HALF_LIFE_DAYS || days > MAX_HALF_LIFE_DAYS) {
    return `Enter a half-life from ${MIN_HALF_LIFE_DAYS} to ${MAX_HALF_LIFE_DAYS} days.`;
  }
  return null;
}
var NOTE_WHAT = "for each direct dependency, the days that it was behind the newest version (MTTU) or on a version with a known vulnerability after a fix was available (MTTR)";
function resultsNote(weightingType) {
  if (weightingType === NO_WEIGHTING) {
    return `Total days: ${NOTE_WHAT}, added up, then averaged over the direct dependencies.`;
  }
  return `Average days, with ${weightingType} weighting: ${NOTE_WHAT}, as a weighted average in which recent days count more. Do not compare them with total days.`;
}

// ../extension/src/core/settings.ts
var DATA_SOURCES = ["depsdev", "native"];
var DEFAULT_SETTINGS = {
  dataSource: "depsdev",
  windowYears: DEFAULT_WINDOW_YEARS,
  startDate: "",
  endDate: "",
  weightingType: "disable",
  halfLife: null,
  packageTimeoutSeconds: 600,
  cacheFolder: "",
  cacheSizeLimitGb: 5,
  toolPath: "",
  parallelRuns: 2,
  automaticRuns: true
};
var SETTING_RANGES = {
  windowYears: { minimum: 1 },
  halfLife: { minimum: 1, maximum: 3650 },
  packageTimeoutSeconds: { minimum: 10 },
  cacheSizeLimitGb: { minimum: 0 },
  parallelRuns: { minimum: 1, maximum: 16 }
};
function parseSettings(raw) {
  const value = (key) => raw[key] ?? DEFAULT_SETTINGS[key];
  const dataSource = value("dataSource");
  if (!DATA_SOURCES.includes(dataSource)) {
    return invalid(`mttx.dataSource "${dataSource}" is not one of ${DATA_SOURCES.join(", ")}.`);
  }
  const weightingType = value("weightingType");
  if (!WEIGHTING_TYPES.includes(weightingType)) {
    return invalid(`mttx.weightingType "${weightingType}" is not one of ${WEIGHTING_TYPES.join(", ")}.`);
  }
  const windowYears = value("windowYears");
  if (!isWholeNumber(windowYears, SETTING_RANGES.windowYears)) {
    return invalid(`mttx.windowYears must be a whole number of ${SETTING_RANGES.windowYears.minimum} or more.`);
  }
  const startDate = String(value("startDate")).trim();
  const endDate = String(value("endDate")).trim();
  for (const [key, date] of [["startDate", startDate], ["endDate", endDate]]) {
    if (date !== "" && !isDate(date)) {
      return invalid(`mttx.${key} "${date}" is not a date in the form YYYY-MM-DD.`);
    }
  }
  if (startDate !== "" && endDate !== "" && startDate >= endDate) {
    return invalid("mttx.startDate must be before mttx.endDate.");
  }
  let halfLife = null;
  if (weightingType === "exponential") {
    halfLife = raw.halfLife;
    if (typeof halfLife !== "number" || halfLifeError(weightingType, String(halfLife)) !== null) {
      const { minimum, maximum } = SETTING_RANGES.halfLife;
      return invalid(`Exponential weighting needs mttx.halfLife from ${minimum} to ${maximum} days.`);
    }
  }
  const packageTimeoutSeconds = value("packageTimeoutSeconds");
  if (!isWholeNumber(packageTimeoutSeconds, SETTING_RANGES.packageTimeoutSeconds)) {
    const { minimum } = SETTING_RANGES.packageTimeoutSeconds;
    return invalid(`mttx.packageTimeoutSeconds must be a whole number of ${minimum} or more.`);
  }
  const cacheSizeLimitGb = value("cacheSizeLimitGb");
  if (typeof cacheSizeLimitGb !== "number" || !(cacheSizeLimitGb >= SETTING_RANGES.cacheSizeLimitGb.minimum)) {
    return invalid(`mttx.cacheSizeLimitGb must be a number of ${SETTING_RANGES.cacheSizeLimitGb.minimum} or more.`);
  }
  const parallelRuns = value("parallelRuns");
  if (!isWholeNumber(parallelRuns, SETTING_RANGES.parallelRuns)) {
    const { minimum, maximum } = SETTING_RANGES.parallelRuns;
    return invalid(`mttx.parallelRuns must be a whole number from ${minimum} to ${maximum}.`);
  }
  const automaticRuns = value("automaticRuns");
  if (typeof automaticRuns !== "boolean") return invalid("mttx.automaticRuns must be true or false.");
  return {
    ok: true,
    settings: {
      dataSource,
      windowYears,
      startDate,
      endDate,
      weightingType,
      halfLife,
      packageTimeoutSeconds,
      cacheFolder: String(value("cacheFolder")).trim(),
      cacheSizeLimitGb,
      toolPath: String(value("toolPath")).trim(),
      parallelRuns,
      automaticRuns
    }
  };
}
function isWholeNumber(value, range) {
  return Number.isInteger(value) && value >= range.minimum && value <= (range.maximum ?? Infinity);
}
function toolOutputDir(settings, defaultDir) {
  return settings.cacheFolder || defaultDir;
}
function invalid(message) {
  return { ok: false, message };
}
function isDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = localDate(text);
  return formatDate(date) === text;
}
function toolRequest(key, settings, today, defaultDir) {
  const end = settings.endDate ? localDate(settings.endDate) : today;
  return {
    ecosystem: key.ecosystem,
    packageName: key.name,
    dataSource: settings.dataSource,
    startDate: settings.startDate || windowStartDate(end, settings.windowYears),
    endDate: formatDate(end),
    weightingType: settings.weightingType,
    halfLife: settings.halfLife,
    outputDir: toolOutputDir(settings, defaultDir),
    timeoutSeconds: settings.packageTimeoutSeconds
  };
}
function localDate(text) {
  const [year, month, day] = text.split("-").map(Number);
  return new Date(year, month - 1, day);
}

// ../extension/src/core/toml.ts
function parseToml(text) {
  return new TomlScanner(text).parseDocument();
}
function tableAt(table, ...path) {
  let current = table;
  for (const name of path) {
    if (current?.kind !== "table") return void 0;
    current = current.entries.get(name)?.value;
  }
  return current?.kind === "table" ? current : void 0;
}
var BARE_KEY = /[A-Za-z0-9_-]+/y;
var SCALAR = /(?:true|false|[+-]?(?:inf|nan)|[+-]?[0-9][0-9A-Za-z_+\-.:]*(?:[ T][0-9]{2}:[0-9A-Za-z_+\-.:]*)?)/y;
var ESCAPES = {
  b: "\b",
  t: "	",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\x1B",
  '"': '"',
  "\\": "\\"
};
var TomlScanner = class {
  text;
  lineStarts = [0];
  offset = 0;
  constructor(text) {
    this.text = text;
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.lineStarts.push(i + 1);
  }
  parseDocument() {
    const root = newTable();
    let current = root;
    if (this.text.charCodeAt(0) === 65279) this.offset = 1;
    for (; ; ) {
      this.skipBlankLines();
      if (this.offset >= this.text.length) return root;
      if (this.text[this.offset] === "[") current = this.parseHeader(root);
      else this.parseKeyValue(current);
      this.expectLineEnd();
    }
  }
  // Parse `[a.b]` or `[[a.b]]` and return the table that the next key-value pairs go into.
  parseHeader(root) {
    const isArray = this.text.startsWith("[[", this.offset);
    this.offset += isArray ? 2 : 1;
    const parts = this.parseKey();
    this.expect(isArray ? "]]" : "]");
    const parent = this.descend(root, parts.slice(0, -1));
    const last = parts[parts.length - 1];
    const entry = parent.entries.get(last.name);
    if (isArray) {
      const table = newTable();
      if (!entry) {
        parent.entries.set(last.name, { key: this.position(last.start, last.end), value: { kind: "array", items: [table] } });
      } else if (entry.value.kind === "array") {
        entry.value.items.push(table);
      } else {
        this.fail();
      }
      return table;
    }
    if (!entry) {
      const table = newTable();
      parent.entries.set(last.name, { key: this.position(last.start, last.end), value: table });
      return table;
    }
    if (entry.value.kind !== "table") this.fail();
    return entry.value;
  }
  parseKeyValue(table) {
    const parts = this.parseKey();
    this.skipSpace();
    this.expect("=");
    this.skipSpace();
    const value = this.parseValue();
    const parent = this.descend(table, parts.slice(0, -1));
    const last = parts[parts.length - 1];
    parent.entries.set(last.name, { key: this.position(last.start, last.end), value });
  }
  // Return the table at the key parts below `table`, and make the tables that do not exist.
  descend(table, parts) {
    let current = table;
    for (const part of parts) {
      let entry = current.entries.get(part.name);
      if (!entry) {
        entry = { key: this.position(part.start, part.end), value: newTable() };
        current.entries.set(part.name, entry);
      }
      let value = entry.value;
      if (value.kind === "array") value = value.items[value.items.length - 1];
      if (value?.kind !== "table") this.fail();
      current = value;
    }
    return current;
  }
  // Parse a dotted key, for example `a."b.c".'d'`.
  parseKey() {
    const parts = [];
    for (; ; ) {
      this.skipSpace();
      const start = this.offset;
      const char = this.text[this.offset];
      let name;
      if (char === '"') name = this.parseBasicString();
      else if (char === "'") name = this.parseLiteralString();
      else name = this.match(BARE_KEY) ?? this.fail();
      parts.push({ name, start, end: this.offset });
      this.skipSpace();
      if (this.text[this.offset] !== ".") return parts;
      this.offset++;
    }
  }
  parseValue() {
    const start = this.offset;
    const char = this.text[this.offset];
    if (char === "[") return this.parseArray();
    if (char === "{") return this.parseInlineTable();
    if (char === '"' || char === "'") {
      const multiLine = this.text.startsWith(char.repeat(3), this.offset);
      let value;
      if (multiLine) value = char === '"' ? this.parseMultiLineBasic() : this.parseMultiLineLiteral();
      else value = char === '"' ? this.parseBasicString() : this.parseLiteralString();
      const quote = multiLine ? 3 : 1;
      return {
        kind: "string",
        value,
        raw: this.text.slice(start + quote, this.offset - quote),
        position: this.position(start, this.offset)
      };
    }
    if (this.match(SCALAR) === void 0) this.fail();
    return { kind: "other" };
  }
  parseArray() {
    const items = [];
    this.offset++;
    for (; ; ) {
      this.skipBlankLines();
      if (this.text[this.offset] === "]") break;
      items.push(this.parseValue());
      this.skipBlankLines();
      if (this.text[this.offset] !== ",") break;
      this.offset++;
    }
    this.expect("]");
    return { kind: "array", items };
  }
  parseInlineTable() {
    const table = newTable();
    this.offset++;
    for (; ; ) {
      this.skipBlankLines();
      if (this.text[this.offset] === "}") break;
      this.parseKeyValue(table);
      this.skipBlankLines();
      if (this.text[this.offset] !== ",") break;
      this.offset++;
    }
    this.expect("}");
    return table;
  }
  parseBasicString() {
    this.offset++;
    let value = "";
    for (; ; ) {
      const char = this.text[this.offset];
      if (char === void 0 || char === "\n" || char === "\r") this.fail();
      if (char === '"') {
        this.offset++;
        return value;
      }
      if (char === "\\") value += this.parseEscape();
      else {
        value += char;
        this.offset++;
      }
    }
  }
  parseMultiLineBasic() {
    this.offset += 3;
    this.skipNewline();
    let value = "";
    for (; ; ) {
      if (this.offset >= this.text.length) this.fail();
      if (this.text.startsWith('"""', this.offset)) {
        let end = this.offset + 3;
        while (this.text[end] === '"' && end - this.offset < 5) end++;
        value += '"'.repeat(end - this.offset - 3);
        this.offset = end;
        return value;
      }
      const char = this.text[this.offset];
      if (char === "\\") {
        const rest = /\\[ \t]*\r?\n[ \t\r\n]*/y;
        rest.lastIndex = this.offset;
        if (rest.test(this.text)) this.offset = rest.lastIndex;
        else value += this.parseEscape();
      } else {
        value += char;
        this.offset++;
      }
    }
  }
  parseLiteralString() {
    const end = this.text.indexOf("'", this.offset + 1);
    if (end < 0) this.fail();
    const value = this.text.slice(this.offset + 1, end);
    if (/[\r\n]/.test(value)) this.fail();
    this.offset = end + 1;
    return value;
  }
  parseMultiLineLiteral() {
    this.offset += 3;
    this.skipNewline();
    const end = this.text.indexOf("'''", this.offset);
    if (end < 0) this.fail();
    let close = end + 3;
    while (this.text[close] === "'" && close - end < 5) close++;
    const value = this.text.slice(this.offset, close - 3);
    this.offset = close;
    return value;
  }
  parseEscape() {
    const code = this.text[this.offset + 1];
    if (code in ESCAPES) {
      this.offset += 2;
      return ESCAPES[code];
    }
    const digits = code === "x" ? 2 : code === "u" ? 4 : code === "U" ? 8 : 0;
    const hex = this.text.slice(this.offset + 2, this.offset + 2 + digits);
    if (digits === 0 || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== digits) this.fail();
    this.offset += 2 + digits;
    return String.fromCodePoint(parseInt(hex, 16));
  }
  // Skip spaces, tabs, comments, and line ends.
  skipBlankLines() {
    for (; ; ) {
      this.skipSpace();
      const char = this.text[this.offset];
      if (char === "#") this.skipComment();
      else if (char === "\n" || char === "\r") this.offset++;
      else return;
    }
  }
  expectLineEnd() {
    this.skipSpace();
    if (this.text[this.offset] === "#") this.skipComment();
    if (this.offset >= this.text.length) return;
    if (!this.skipNewline()) this.fail();
  }
  skipNewline() {
    if (this.text.startsWith("\r\n", this.offset)) this.offset += 2;
    else if (this.text[this.offset] === "\n") this.offset++;
    else return false;
    return true;
  }
  skipComment() {
    while (this.offset < this.text.length && this.text[this.offset] !== "\n") this.offset++;
  }
  skipSpace() {
    while (this.text[this.offset] === " " || this.text[this.offset] === "	") this.offset++;
  }
  match(pattern) {
    pattern.lastIndex = this.offset;
    const found = pattern.exec(this.text);
    if (!found) return void 0;
    this.offset = pattern.lastIndex;
    return found[0];
  }
  expect(token) {
    if (!this.text.startsWith(token, this.offset)) this.fail();
    this.offset += token.length;
  }
  // The position of the text from `start` to `end`. A range over more than one line ends at
  // the end of its first line.
  position(start, end) {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lineStarts[middle] <= start) low = middle;
      else high = middle - 1;
    }
    const lineStart = this.lineStarts[low];
    const lineEnd = low + 1 < this.lineStarts.length ? this.lineStarts[low + 1] - 1 : this.text.length;
    return { line: low, startCharacter: start - lineStart, endCharacter: Math.min(end, lineEnd) - lineStart };
  }
  fail() {
    throw new SyntaxError(`TOML syntax error at offset ${this.offset}`);
  }
};
function newTable() {
  return { kind: "table", entries: /* @__PURE__ */ new Map() };
}

// ../extension/src/core/cargo.ts
var SECTIONS = {
  dependencies: "dependencies",
  "dev-dependencies": "dev-dependencies",
  dev_dependencies: "dev-dependencies",
  "build-dependencies": "build-dependencies",
  build_dependencies: "build-dependencies"
};
function parseCargoToml(text) {
  let root;
  try {
    root = parseToml(text);
  } catch {
    return [];
  }
  const deps = [];
  addSections(deps, root, "");
  for (const [target] of tableAt(root, "target")?.entries ?? []) {
    addSections(deps, tableAt(root, "target", target), `target.${target}.`);
  }
  return deps.sort((a, b) => a.line - b.line || a.startCharacter - b.startCharacter);
}
function addSections(deps, parent, prefix) {
  for (const [key, section] of Object.entries(SECTIONS)) {
    for (const [name, entry] of tableAt(parent, key)?.entries ?? []) {
      const crate = crateName(name, entry.value);
      if (crate) deps.push({ ecosystem: "cargo", name: crate, section: prefix + section, ...entry.key });
    }
  }
}
function crateName(key, value) {
  if (value.kind === "string") return key;
  if (value.kind !== "table") return void 0;
  const { entries } = value;
  if (entries.has("git") || entries.has("registry")) return void 0;
  if (entries.has("path") && !entries.has("version")) return void 0;
  const renamed = entries.get("package")?.value;
  return renamed?.kind === "string" ? renamed.value : key;
}

// ../extension/src/core/pyproject.ts
var REQUIREMENT_NAME = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/;
var DIRECT_URL = /^[^;]*@/;
var POETRY_NOT_PYPI = ["git", "path", "url"];
function parsePyproject(text) {
  let root;
  try {
    root = parseToml(text);
  } catch {
    return [];
  }
  const deps = [];
  const project = tableAt(root, "project");
  addRequirements(deps, project?.entries.get("dependencies")?.value, "project.dependencies");
  for (const [extra, entry] of tableAt(project, "optional-dependencies")?.entries ?? []) {
    addRequirements(deps, entry.value, `project.optional-dependencies.${extra}`);
  }
  for (const [group, entry] of tableAt(root, "dependency-groups")?.entries ?? []) {
    addRequirements(deps, entry.value, `dependency-groups.${group}`);
  }
  const poetry = tableAt(root, "tool", "poetry");
  addPoetryTable(deps, tableAt(poetry, "dependencies"), "tool.poetry.dependencies");
  addPoetryTable(deps, tableAt(poetry, "dev-dependencies"), "tool.poetry.dev-dependencies");
  for (const [group] of tableAt(poetry, "group")?.entries ?? []) {
    const table = tableAt(poetry, "group", group, "dependencies");
    addPoetryTable(deps, table, `tool.poetry.group.${group}.dependencies`);
  }
  return deps.sort((a, b) => a.line - b.line || a.startCharacter - b.startCharacter);
}
function addRequirements(deps, list, section) {
  if (list?.kind !== "array") return;
  for (const item of list.items) {
    if (item.kind !== "string" || DIRECT_URL.test(item.value)) continue;
    const name = REQUIREMENT_NAME.exec(item.value)?.[1];
    if (!name) continue;
    const inRaw = REQUIREMENT_NAME.exec(item.raw);
    const { line, startCharacter, endCharacter } = item.position;
    const nameStart = startCharacter + 1 + (inRaw ? inRaw[0].length - name.length : 0);
    deps.push({
      ecosystem: "pypi",
      name,
      section,
      line,
      startCharacter: inRaw?.[1] === name ? nameStart : startCharacter,
      endCharacter: inRaw?.[1] === name ? nameStart + name.length : endCharacter
    });
  }
}
function addPoetryTable(deps, table, section) {
  for (const [name, entry] of table?.entries ?? []) {
    if (name.toLowerCase() === "python" || !isPoetryPypiDependency(entry)) continue;
    deps.push({ ecosystem: "pypi", name, section, ...entry.key });
  }
}
function isPoetryPypiDependency(entry) {
  const { value } = entry;
  if (value.kind !== "table") return true;
  return !POETRY_NOT_PYPI.some((key) => value.entries.has(key));
}

// ../extension/src/core/manifest.ts
var PARSERS = {
  "package.json": parsePackageJson,
  "pyproject.toml": parsePyproject,
  "Cargo.toml": parseCargoToml
};
function parseManifest(fileName, text) {
  const parser = PARSERS[baseName(fileName)];
  return parser ? parser(text) : [];
}
function baseName(fileName) {
  return fileName.split(/[\\/]/).pop() ?? "";
}
var NPM_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
function parsePackageJson(text) {
  let root;
  try {
    root = new JsonScanner(text).parseDocument();
  } catch {
    return [];
  }
  if (root.kind !== "object") return [];
  const lines = lineStarts(text);
  const deps = [];
  for (const member of root.members) {
    if (!NPM_SECTIONS.includes(member.key) || member.value.kind !== "object") continue;
    for (const dep of member.value.members) {
      if (dep.value.kind !== "string") continue;
      const start = position(lines, dep.keyStart);
      deps.push({
        ecosystem: "npm",
        name: dep.key,
        section: member.key,
        line: start.line,
        startCharacter: start.character,
        endCharacter: position(lines, dep.keyEnd).character
      });
    }
  }
  return deps;
}
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}
function position(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low, character: offset - starts[low] };
}
var JsonScanner = class {
  text;
  offset = 0;
  constructor(text) {
    this.text = text;
  }
  parseDocument() {
    if (this.text.charCodeAt(0) === 65279) this.offset = 1;
    const value = this.parseValue();
    this.skipSpace();
    if (this.offset !== this.text.length) this.fail();
    return value;
  }
  parseValue() {
    this.skipSpace();
    const char = this.text[this.offset];
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"') return { kind: "string", value: this.parseString() };
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      this.text.slice(this.offset, this.offset + 400)
    );
    if (!literal) this.fail();
    this.offset += literal[0].length;
    return { kind: "other" };
  }
  parseObject() {
    const members = [];
    this.offset++;
    this.skipSpace();
    if (this.text[this.offset] === "}") {
      this.offset++;
      return { kind: "object", members };
    }
    for (; ; ) {
      this.skipSpace();
      if (this.text[this.offset] !== '"') this.fail();
      const keyStart = this.offset;
      const key = this.parseString();
      const keyEnd = this.offset;
      this.skipSpace();
      this.expect(":");
      members.push({ key, keyStart, keyEnd, value: this.parseValue() });
      this.skipSpace();
      if (this.text[this.offset] === "}") {
        this.offset++;
        return { kind: "object", members };
      }
      this.expect(",");
    }
  }
  parseArray() {
    this.offset++;
    this.skipSpace();
    if (this.text[this.offset] === "]") {
      this.offset++;
      return { kind: "other" };
    }
    for (; ; ) {
      this.parseValue();
      this.skipSpace();
      if (this.text[this.offset] === "]") {
        this.offset++;
        return { kind: "other" };
      }
      this.expect(",");
    }
  }
  parseString() {
    const match = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(
      this.text.slice(this.offset)
    );
    if (!match) this.fail();
    this.offset += match[0].length;
    return JSON.parse(match[0]);
  }
  expect(char) {
    if (this.text[this.offset] !== char) this.fail();
    this.offset++;
  }
  skipSpace() {
    while (/[ \t\r\n]/.test(this.text[this.offset] ?? "")) this.offset++;
  }
  fail() {
    throw new SyntaxError(`JSON syntax error at offset ${this.offset}`);
  }
};

// src/added.ts
function addedDependencies(changes) {
  const added = /* @__PURE__ */ new Map();
  for (const change of changes) {
    if (!isAnalyzedManifest(change.path) || change.head === null) continue;
    const before = new Set(
      parseManifest(change.path, change.base ?? "").map((dep) => packageKey(dep.ecosystem, dep.name))
    );
    for (const dep of parseManifest(change.path, change.head)) {
      const key = packageKey(dep.ecosystem, dep.name);
      if (before.has(key)) continue;
      const id = `${dep.ecosystem}:${key}`;
      const entry = added.get(id);
      if (!entry) added.set(id, { ecosystem: dep.ecosystem, name: dep.name, files: [change.path] });
      else if (!entry.files.includes(change.path)) entry.files.push(change.path);
    }
  }
  return [...added.values()];
}

// ../webapp/site/static/js/explanation.js
var LIMITATIONS = [
  "Only vulnerabilities with a fix count. A vulnerability with no fix does not change MTTR.",
  "The results use the OSV data as of the date of the OSV index. A vulnerability that OSV added later does not count.",
  "A dependency with no version constraint always resolves to the newest version, so it counts as up to date.",
  "Only direct dependencies count. The dependencies of a dependency do not count.",
  "The results depend on the declared version constraints and on the release dates in the registry."
];
var EXPLANATION_HEADING = "What the results mean";
var LIMITATIONS_HEADING = "Limitations";
var OSV_LIMITATION = 1;
function limitationsFor(osvIndexDate) {
  const list = [...LIMITATIONS];
  if (typeof osvIndexDate === "string" && osvIndexDate !== "") {
    list[OSV_LIMITATION] = `The results use the OSV data as of ${osvIndexDate}, the build date of the OSV index. A vulnerability that OSV added later does not count.`;
  }
  return list;
}
var METRIC_WORDS = {
  mttu: {
    zero: "In this time window, each direct dependency used the newest available version at all times.",
    what: "was behind the newest available version",
    hoverZero: "Each direct dependency used the newest version at all times",
    hover: "A direct dependency was behind the newest version"
  },
  mttr: {
    zero: "In this time window, no direct dependency stayed on a version with a known vulnerability after a fix was available.",
    what: "stayed on a version with a known vulnerability after a fix was available",
    hoverZero: "none stayed on a known vulnerable version after a fix was available",
    hover: "on a known vulnerable version after a fix"
  }
};
function showsZero(days) {
  return formatDays(days) === formatDays(0);
}
function amountWords(days, result) {
  const value = formatDays(days);
  if (result.weighting_type === NO_WEIGHTING) {
    return {
      sentence: `for ${value} days in total, on average over the direct dependencies`,
      hover: `${value} days in total (mean over the direct dependencies)`
    };
  }
  const exponential = result.weighting_type === EXPONENTIAL;
  const weighting = exponential ? { long: `exponential weighting and a half-life of ${result.half_life} days`, short: `half-life ${result.half_life} days` } : { long: `${result.weighting_type} weighting`, short: `${result.weighting_type} weighting` };
  return {
    sentence: `for ${value} days on average, with ${weighting.long}`,
    hover: `${value} days on average (${weighting.short})`
  };
}
function metricSentence(metric, days, result) {
  const words = METRIC_WORDS[metric];
  if (showsZero(days)) return words.zero;
  const value = formatDays(days);
  const amount = amountWords(days, result).sentence;
  return `${metric.toUpperCase()} is ${value} days: in this time window, a direct dependency of ${result.package} ${words.what} ${amount}.`;
}
var WHY_CHANGE = {
  mttu: "MTTU goes up when a dependency publishes a newer version and the package keeps the older one. It goes down when a release of the package moves to newer versions.",
  mttr: "MTTR goes up when a fix is published and the package stays on the vulnerable version. It goes down when a release moves to the fixed version."
};
var WEIGHTING_CHANGE = "With weighting, recent days count more, so a value can also change as time passes.";
function largestStep(metric, releases, sign) {
  let best = null;
  for (let index = 1; index < releases.length; index += 1) {
    const [before, after] = [releases[index - 1][metric], releases[index][metric]];
    if (formatDays(before) === formatDays(after)) continue;
    const change = (after - before) * sign;
    if (change > 0 && (best === null || change > best.change)) best = { change, before, release: releases[index] };
  }
  return best;
}
function changeSentences(metric, releases) {
  const name = metric.toUpperCase();
  const first = formatDays(releases[0][metric]);
  const last = formatDays(releases.at(-1)[metric]);
  const sentences = [`${name} went from ${first} to ${last} days over ${releases.length} releases.`];
  for (const [sign, word] of [[1, "rise"], [-1, "drop"]]) {
    const step = largestStep(metric, releases, sign);
    if (step === null) continue;
    const { release } = step;
    sentences.push(
      `The largest ${word} of ${name} was at ${release.package_version} (${release.package_release_date}), from ${formatDays(step.before)} to ${formatDays(release[metric])} days.`
    );
  }
  sentences.push(WHY_CHANGE[metric]);
  return sentences;
}
function releasesWithValues(result) {
  return (result.releases ?? []).filter(hasValue);
}
function describedEntry(result) {
  if (result.error) return null;
  if (result.mode === "per_release") return releasesWithValues(result).at(-1) ?? null;
  return hasValue(result.summary) ? result.summary : null;
}
function explainResult(result) {
  const entry = describedEntry(result);
  if (entry === null) return null;
  const sentences = [metricSentence("mttu", entry.mttu, result), metricSentence("mttr", entry.mttr, result)];
  if (result.mode !== "per_release") return { title: result.package, sentences };
  const releases = releasesWithValues(result);
  if (releases.length > 1) {
    for (const metric of ["mttu", "mttr"]) sentences.push(...changeSentences(metric, releases));
    if (result.weighting_type !== NO_WEIGHTING) sentences.push(WEIGHTING_CHANGE);
  }
  const title = `${result.package} ${entry.package_version}, the latest release with a value (${entry.package_release_date})`;
  return { title, sentences };
}
function explainComparison(job) {
  const packages = job.results.map(explainResult).filter((item) => item !== null);
  return { packages, limitations: packages.length > 0 ? limitationsFor(job.osv_index_date) : [] };
}
function explanationBlocks(job) {
  const { packages, limitations } = explainComparison(job);
  if (packages.length === 0) return [];
  return [
    { kind: "heading", text: EXPLANATION_HEADING },
    ...packages.map((item) => ({ kind: "paragraph", title: item.title, text: item.sentences.join(" ") })),
    { kind: "subheading", text: LIMITATIONS_HEADING },
    { kind: "list", items: limitations }
  ];
}

// ../extension/src/core/display.ts
function hasNoDependencies2(entry) {
  return entry.status === "no_deps" || entry.status === "ok" && entry.num_dependencies === 0;
}
function noDependenciesText(packageName) {
  return `could not compute since '${packageName}' has no dependencies`;
}

// ../extension/src/core/comparison.ts
var COMPARISON_ECOSYSTEMS = ["npm", "pypi", "cargo"];
function parsePackageNames(ecosystem, text) {
  const names = text.split(/[\s,]+/).filter((name) => name !== "");
  const [error] = packageErrors(ecosystem, names);
  return error ? { error } : { names };
}

// src/inputs.ts
var TARGETS = ["packages", "pull-request"];
var OSV_INDEX_SOURCES = ["image", "fresh"];
var SETTING_INPUTS = {
  dataSource: "data-source",
  windowYears: "window-years",
  startDate: "start-date",
  endDate: "end-date",
  weightingType: "weighting-type",
  halfLife: "half-life",
  packageTimeoutSeconds: "package-timeout-seconds",
  parallelRuns: "parallel-runs"
};
var NUMBER_SETTINGS = /* @__PURE__ */ new Set(["windowYears", "halfLife", "packageTimeoutSeconds", "parallelRuns"]);
function parseInputs(inputs2) {
  const input = (name) => (inputs2[name] ?? "").trim();
  const target = input("target") || "packages";
  if (!TARGETS.includes(target)) return oneOf("target", target, TARGETS);
  const osvIndex = input("osv-index") || "image";
  if (!OSV_INDEX_SOURCES.includes(osvIndex)) {
    return oneOf("osv-index", osvIndex, OSV_INDEX_SOURCES);
  }
  let packages = [];
  let ecosystem = null;
  if (target === "packages") {
    if (input("packages") === "") {
      return invalid2(`Input packages needs 1 to ${MAX_PACKAGES} package names, split by commas or spaces.`);
    }
    const name = input("ecosystem");
    if (!COMPARISON_ECOSYSTEMS.includes(name)) return oneOf("ecosystem", name, COMPARISON_ECOSYSTEMS);
    ecosystem = name;
    const parsed = parsePackageNames(ecosystem, input("packages"));
    if ("error" in parsed) return invalid2(`Input packages: ${parsed.error}`);
    packages = parsed.names;
  }
  const raw = {};
  for (const [key, name] of Object.entries(SETTING_INPUTS)) {
    const text = input(name);
    if (text === "") continue;
    raw[key] = NUMBER_SETTINGS.has(key) && text !== "" && Number.isFinite(Number(text)) ? Number(text) : text;
  }
  const settings = parseSettings(raw);
  if (!settings.ok) {
    const message = settings.message.replace(/mttx\.(\w+)/g, (_, key) => `input ${SETTING_INPUTS[key]}`);
    return invalid2(message.charAt(0).toUpperCase() + message.slice(1));
  }
  const thresholds = { mttu: null, mttr: null };
  for (const metric of ["mttu", "mttr"]) {
    const name = `max-${metric}-days`;
    const text = input(name);
    if (text === "") continue;
    const days = Number(text);
    if (!Number.isFinite(days) || days < 0) return invalid2(`Input ${name} must be a number of 0 or more.`);
    thresholds[metric] = days;
  }
  return {
    ok: true,
    config: {
      target,
      packages,
      ecosystem,
      settings: settings.settings,
      thresholds,
      osvIndex,
      badgeDir: input("badge-dir") || "mttx-badges"
    }
  };
}
function oneOf(name, value, allowed) {
  return invalid2(`Input ${name} "${value}" is not one of ${allowed.join(", ")}.`);
}
function invalid2(message) {
  return { ok: false, message };
}

// src/report.ts
var COMMENT_MARKER = "<!-- mttx-action -->";
var METRICS = ["mttu", "mttr"];
var NO_VALUE2 = "\u2013";
var DATA_SOURCE_NAMES = { depsdev: "deps.dev", native: "the package registries" };
function outputRows(outcomes) {
  return outcomes.map(({ ecosystem, name, outcome }) => {
    const row = { ecosystem, package: name, mttu: null, mttr: null, num_dependencies: 0, status: "error", error: "" };
    if (outcome.kind === "failed") return { ...row, error: outcome.message };
    const { result } = outcome;
    const summary = result.summary;
    if (!summary) return { ...row, error: result.error || "the Tool gave no summary" };
    row.num_dependencies = summary.num_dependencies;
    if (!result.error && hasNoDependencies2(summary)) return { ...row, status: "no_deps" };
    if (result.error || summary.status !== "ok" || summary.mttu === null || summary.mttr === null) {
      return { ...row, error: result.error || summary.error || "the Tool gave no value" };
    }
    return { ...row, mttu: summary.mttu, mttr: summary.mttr, status: "ok" };
  });
}
function thresholdFailures(rows, thresholds) {
  const messages = [];
  for (const row of rows) {
    for (const metric of METRICS) {
      if (!isOver(row, metric, thresholds)) continue;
      messages.push(
        `The ${metric.toUpperCase()} of ${row.package} (${row.ecosystem}) is ${formatDays(row[metric])} days, more than max-${metric}-days (${thresholds[metric]}).`
      );
    }
  }
  return messages;
}
function isOver(row, metric, thresholds) {
  const limit = thresholds[metric];
  const value = row[metric];
  return limit !== null && value !== null && value > limit;
}
function badgeFiles(rows, thresholds) {
  return rows.flatMap(
    (row) => METRICS.map((metric) => {
      const value = row[metric];
      let message = "error";
      let color = "lightgrey";
      if (row.status === "no_deps") message = "no dependencies";
      if (value !== null) {
        message = `${formatDays(value)} days`;
        color = thresholds[metric] === null ? "blue" : isOver(row, metric, thresholds) ? "red" : "brightgreen";
      }
      const safeName = row.package.replace(/\//g, "__").replace(/[^A-Za-z0-9._-]/g, "");
      return {
        fileName: `${row.ecosystem}-${safeName}-${metric}.json`,
        json: { schemaVersion: 1, label: metric.toUpperCase(), message, color }
      };
    })
  );
}
function reportMarkdown(outcomes, options) {
  const rows = outputRows(outcomes);
  const lines = [COMMENT_MARKER, `### ${options.heading}`, ""];
  const results = outcomes.flatMap((item) => item.outcome.kind === "result" ? [item.outcome.result] : []);
  const first = results[0];
  if (first) {
    const source = DATA_SOURCE_NAMES[first.data_source] ?? first.data_source;
    const halfLife = first.half_life === null ? "" : `, half-life ${first.half_life} days`;
    lines.push(`Window: ${first.start_date} to ${first.end_date} \xB7 Data source: ${source} \xB7 Weighting: ${first.weighting_type}${halfLife}`, "");
  }
  const header = ["Package", "Ecosystem", "MTTU (days)", "MTTR (days)", "Dependencies", ...options.showFiles ? ["Manifest"] : [], "Note"];
  lines.push(tableRow(header), tableRow(header.map(() => "---")));
  rows.forEach((row, index) => {
    const values = METRICS.map((metric) => {
      if (row[metric] === null) return NO_VALUE2;
      const text = formatDays(row[metric]);
      return isOver(row, metric, options.thresholds) ? `**${text}**` : text;
    });
    const files = options.showFiles ? [outcomes[index].files.map(inlineCode).join(", ")] : [];
    lines.push(tableRow([inlineCode(row.package), row.ecosystem, ...values, String(row.num_dependencies), ...files, note(row, options.thresholds)]));
  });
  if (first) lines.push("", escapeMarkdown(resultsNote(first.weighting_type)));
  lines.push(...explanationMarkdown(results, options.osvIndexDate));
  return lines.join("\n");
}
function note(row, thresholds) {
  if (row.status === "no_deps") return escapeCell(noDependenciesText(row.package));
  if (row.status === "error") return `error: ${escapeCell(row.error)}`;
  return METRICS.filter((metric) => isOver(row, metric, thresholds)).map((metric) => `${metric.toUpperCase()} is more than max-${metric}-days (${thresholds[metric]})`).join("; ");
}
function explanationMarkdown(results, osvIndexDate) {
  const job = { results, ...osvIndexDate ? { osv_index_date: osvIndexDate } : {} };
  const lines = [];
  for (const block of explanationBlocks(job)) {
    if (block.kind === "heading" || block.kind === "subheading") {
      if (lines.at(-1) !== "") lines.push("");
      lines.push(`#### ${block.text}`, "");
    }
    if (block.kind === "paragraph") lines.push(`**${escapeMarkdown(block.title)}**: ${escapeMarkdown(block.text)}`, "");
    if (block.kind === "list") lines.push(...block.items.map((item) => `- ${escapeMarkdown(item)}`));
  }
  while (lines.at(-1) === "") lines.pop();
  return lines;
}
function tableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}
function escapeCell(text) {
  return text.trim().replace(/\s*\r?\n\s*/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|");
}
function escapeMarkdown(text) {
  return text.replace(/[\\`*_[\]<>|~]/g, "\\$&");
}
function inlineCode(text) {
  return `\`${text.replace(/`/g, "'").replace(/\|/g, "\\|")}\``;
}

// src/main.ts
var NO_DEPENDENCIES_ADDED = "This pull request adds no dependencies.";
async function runAction(io) {
  const parsed = parseInputs(io.inputs);
  if (!parsed.ok) {
    io.error(parsed.message);
    return 1;
  }
  const { config } = parsed;
  if (config.target === "pull-request" && !io.pullRequest) {
    io.error("Input target pull-request needs a pull_request event (on: pull_request or pull_request_target).");
    return 1;
  }
  let packages;
  if (config.target === "packages") {
    packages = config.packages.map((name) => ({ ecosystem: config.ecosystem, name, files: [] }));
  } else {
    packages = addedDependencies(await io.pullRequest.changes());
    io.setOutput("added", JSON.stringify(packages));
    io.info(`The pull request adds ${packages.length} dependencies.`);
  }
  if (packages.length === 0) {
    io.setOutput("results", "[]");
    io.setOutput("mttu", "");
    io.setOutput("mttr", "");
    io.setOutput("over-threshold", "false");
    io.setOutput("comment-url", await upsertComment(io, `${COMMENT_MARKER}
${NO_DEPENDENCIES_ADDED}
`, false) ?? "");
    io.appendSummary(`${NO_DEPENDENCIES_ADDED}
`);
    return 0;
  }
  const seam = io.openTool(config.osvIndex);
  const osvIndexDate = await prepareOsvIndex(io, seam, config);
  const outcomes = await runPool(packages, config.settings.parallelRuns, async (dep) => {
    io.info(`Analyzing ${dep.name} (${dep.ecosystem})`);
    return { ...dep, outcome: await analyze(io, seam, config, dep) };
  });
  const rows = outputRows(outcomes);
  const failures = thresholdFailures(rows, config.thresholds);
  const first = rows[0];
  io.setOutput("results", JSON.stringify(rows));
  io.setOutput("mttu", first.mttu === null ? "" : formatDays(first.mttu));
  io.setOutput("mttr", first.mttr === null ? "" : formatDays(first.mttr));
  io.setOutput("over-threshold", String(failures.length > 0));
  const pullRequest2 = config.target === "pull-request";
  const markdown = reportMarkdown(outcomes, {
    heading: pullRequest2 ? "MTTU and MTTR of the dependencies that this pull request adds" : "MTTU and MTTR",
    thresholds: config.thresholds,
    showFiles: pullRequest2,
    ...osvIndexDate ? { osvIndexDate } : {}
  });
  io.appendSummary(`${markdown}
`);
  if (pullRequest2) {
    io.setOutput("comment-url", await upsertComment(io, markdown, true) ?? "");
  } else {
    for (const file of badgeFiles(rows, config.thresholds)) {
      io.writeFile(`${config.badgeDir}/${file.fileName}`, `${JSON.stringify(file.json)}
`);
    }
  }
  for (const message of failures) io.error(message);
  return failures.length > 0 ? 1 : 0;
}
async function prepareOsvIndex(io, { tool, outputDir }, config) {
  let state = parseOsvIndexDate((await tool(osvIndexDateArgs(outputDir))).stdout);
  const today = formatDate(io.today);
  if (config.osvIndex === "fresh" && !(state?.kind === "built" && state.date === today)) {
    io.info("Building the OSV index of today. AGENTS.md of imranur-rahman/dependency-update-metrics gives the download size.");
    const build = await tool(buildOsvArgs(outputDir));
    if (build.exitCode !== 0) io.warning(`The OSV index build failed: ${lastLine(build)}`);
    state = parseOsvIndexDate((await tool(osvIndexDateArgs(outputDir))).stdout);
  }
  if (state?.kind === "built") return state.date;
  io.warning("The Tool has no OSV index, so each MTTR is 0. Use the default image, or osv-index: fresh.");
  return void 0;
}
async function analyze(io, { tool, outputDir }, config, dep) {
  const request = toolRequest(dep, config.settings, io.today, outputDir);
  const output = await tool(toolArgs(request), request.timeoutSeconds * 1e3);
  if (output.timedOut) {
    return { kind: "failed", message: `the Tool stopped after ${request.timeoutSeconds} s (package-timeout-seconds)` };
  }
  if (output.error) return { kind: "failed", message: `could not start the Tool: ${output.error}` };
  return parseToolOutput(output);
}
async function upsertComment(io, body, create) {
  if (!io.pullRequest) return void 0;
  const { comments } = io.pullRequest;
  try {
    const old = (await comments.list()).find((comment) => comment.body.startsWith(COMMENT_MARKER));
    if (old) return (await comments.update(old.id, body)).url;
    return create ? (await comments.create(body)).url : void 0;
  } catch (error) {
    io.warning(`The Action could not write the pull request comment: ${error.message}`);
    return void 0;
  }
}
async function runPool(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
function lastLine(output) {
  return output.stderr.trim().split(/\r?\n/).pop() || output.error || `exit code ${output.exitCode}`;
}

// src/index.ts
var env = process.env;
var testing = Boolean(env.MTTX_ACTION_TOOL);
var eventPath = testing && env.MTTX_ACTION_EVENT_PATH || env.GITHUB_EVENT_PATH;
var apiUrl = testing && env.MTTX_ACTION_API_URL || env.GITHUB_API_URL || "https://api.github.com";
function inputs() {
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("INPUT_") && value !== void 0) result[key.slice(6).toLowerCase().replace(/_/g, "-")] = value;
  }
  return result;
}
function command(name, message) {
  const text = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  process.stdout.write(`::${name} title=MTTX::${text}
`);
}
function openTool(osvIndex) {
  const dataDir = env.MTTX_DATA_DIR || resolve(env.RUNNER_TEMP ?? ".", "mttx-data");
  mkdirSync(dataDir, { recursive: true });
  const fake = env.MTTX_ACTION_TOOL;
  if (fake) {
    const fakeCommand = toolCommand(fake);
    return { tool: (args, timeoutMs) => runToolCommand(fakeCommand, args, timeoutMs === void 0 ? {} : { timeoutMs }), outputDir: dataDir };
  }
  const image = imageReference(image_default, osvIndex);
  process.stdout.write(`MTTX runs the Tool in ${image}
`);
  const mount = { hostDir: dataDir, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
  return { tool: dockerTool(image, mount), outputDir: IMAGE_OUTPUT_DIR };
}
function pullRequest(token) {
  if (!eventPath) return void 0;
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const pr = event.pull_request;
  if (!pr?.base?.sha || !pr?.head?.sha) return void 0;
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  return {
    changes: () => gitManifestChanges(workspace, pr.base.sha, pr.head.sha),
    comments: restCommentStore({
      apiUrl,
      repository: env.GITHUB_REPOSITORY ?? "",
      number: pr.number,
      token
    })
  };
}
async function main() {
  const values = inputs();
  const pr = pullRequest(values["github-token"] ?? "");
  const io = {
    inputs: values,
    today: /* @__PURE__ */ new Date(),
    openTool,
    ...pr ? { pullRequest: pr } : {},
    setOutput(name, value) {
      if (!env.GITHUB_OUTPUT) return;
      const delimiter = `mttx_${randomUUID()}`;
      appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}
${value}
${delimiter}
`);
    },
    appendSummary(markdown) {
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
    },
    writeFile(path, text) {
      const target = resolve(env.GITHUB_WORKSPACE ?? process.cwd(), path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    },
    error: (message) => command("error", message),
    warning: (message) => command("warning", message),
    info: (message) => process.stdout.write(`${message}
`)
  };
  return runAction(io);
}
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    command("error", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
);
