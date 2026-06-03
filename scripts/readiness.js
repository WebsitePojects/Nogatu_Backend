const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const backendRoot = path.join(repoRoot, 'Nogatu_Backend');
const frontendRoot = path.join(repoRoot, 'Nogatu_Frontend');
const outputsDir = path.join(repoRoot, 'outputs', 'readiness');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const runDbSmoke = process.argv.includes('--with-smoke');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function walkFiles(rootDir, matcher, result = []) {
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, matcher, result);
      continue;
    }
    if (matcher(fullPath)) result.push(fullPath);
  }
  return result;
}

function scanLines(files, pattern, filter = () => true) {
  const matches = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (pattern.test(line) && filter({ file, line, lineNumber: index + 1 })) {
        matches.push({
          file: path.relative(repoRoot, file),
          lineNumber: index + 1,
          line: line.trim(),
        });
      }
      pattern.lastIndex = 0;
    });
  }
  return matches;
}

function writeLines(fileName, lines) {
  ensureDir(outputsDir);
  fs.writeFileSync(path.join(outputsDir, fileName), `${lines.join('\n')}\n`, 'utf8');
}

function runCommand(label, cwd, args) {
  const command = process.platform === 'win32'
    ? {
        file: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', `${npmCmd} ${args.join(' ')}`],
      }
    : {
        file: npmCmd,
        args,
      };

  const result = spawnSync(command.file, command.args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    shell: false,
  });

  if (result.status === 0) {
    return { label, ok: true, output: result.stdout || result.stderr || '' };
  }

  return {
    label,
    ok: false,
    output: [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'),
  };
}

function formatMatches(matches) {
  return matches.map((match) => `${match.file}:${match.lineNumber} ${match.line}`);
}

function main() {
  ensureDir(outputsDir);

  const backendRuntimeFiles = [
    path.join(backendRoot, 'index.js'),
    ...walkFiles(path.join(backendRoot, 'routes'), (file) => file.endsWith('.js')),
    ...walkFiles(path.join(backendRoot, 'services'), (file) => file.endsWith('.js')),
  ];
  const frontendFiles = walkFiles(path.join(frontendRoot, 'src'), (file) => /\.(js|jsx)$/.test(file));

  const backendRouteMatches = scanLines(
    [path.join(backendRoot, 'index.js'), ...walkFiles(path.join(backendRoot, 'routes'), (file) => file.endsWith('.js'))],
    /app\.use\(|router\.(get|post|put|patch|delete)\(/g
  );
  const frontendRouteMatches = scanLines(frontendFiles, /<Route|path=|BrowserRouter|Routes/g);
  const frontendApiMatches = scanLines(frontendFiles, /api\.(get|post|put|patch|delete)|axios\.(get|post|put|patch|delete)|fetch\(/g);
  const frontendControlMatches = scanLines(frontendFiles, /<button|onClick=|type="submit"|<Link|<NavLink|href=/g);
  const runtimeSchemaMutationMatches = scanLines(
    backendRuntimeFiles,
    /ALTER TABLE|CREATE TABLE IF NOT EXISTS|SHOW COLUMNS/g,
    ({ file, line }) => !(file.endsWith(path.join('Nogatu_Backend', 'index.js')) && line.includes('SESSION_TABLE'))
  );
  const notReadyMatches = scanLines(backendRuntimeFiles, /not ready/gi);

  writeLines('backend-routes.txt', formatMatches(backendRouteMatches));
  writeLines('frontend-routes.txt', formatMatches(frontendRouteMatches));
  writeLines('frontend-api-requests.txt', formatMatches(frontendApiMatches));
  writeLines('frontend-controls.txt', formatMatches(frontendControlMatches));
  writeLines('runtime-schema-mutations.txt', formatMatches(runtimeSchemaMutationMatches));
  writeLines('not-ready-flags.txt', formatMatches(notReadyMatches));

  const checks = [
    runCommand('backend tests', backendRoot, ['test']),
    runCommand('frontend build', frontendRoot, ['run', 'build']),
  ];

  if (runDbSmoke) {
    checks.push(runCommand('backend smoke', backendRoot, ['run', 'smoke']));
  }

  const failures = [];
  for (const check of checks) {
    if (!check.ok) failures.push(`${check.label} failed`);
    writeLines(`${check.label.replace(/\s+/g, '-')}.log`, [check.output || '(no output)']);
  }

  if (runtimeSchemaMutationMatches.length > 0) {
    failures.push(`runtime schema mutation remains in ${runtimeSchemaMutationMatches.length} location(s)`);
  }

  const reportLines = [
    '# Production Readiness Run',
    '',
    `Generated at: ${new Date().toISOString()}`,
    '',
    '## Automated checks',
    ...checks.map((check) => `- ${check.label}: ${check.ok ? 'PASS' : 'FAIL'}`),
    `- backend route inventory: ${backendRouteMatches.length} matches`,
    `- frontend route inventory: ${frontendRouteMatches.length} matches`,
    `- frontend API inventory: ${frontendApiMatches.length} matches`,
    `- frontend control inventory: ${frontendControlMatches.length} matches`,
    `- runtime schema mutation scan: ${runtimeSchemaMutationMatches.length} findings`,
    `- not-ready wording scan: ${notReadyMatches.length} findings`,
    '',
    '## Result',
    failures.length === 0 ? '- PASS' : `- FAIL: ${failures.join('; ')}`,
  ];

  writeLines('latest-readiness-report.md', reportLines);

  if (failures.length > 0) {
    console.error(`[readiness] failed: ${failures.join('; ')}`);
    process.exit(1);
  }

  console.log('[readiness] passed');
}

main();
