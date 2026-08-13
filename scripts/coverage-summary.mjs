import { readFile } from 'node:fs/promises';

const packages = [
  ['worker', 'worker/coverage/coverage-summary.json'],
  ['mcp', 'mcp/coverage/coverage-summary.json'],
  ['cli', 'cli/npm/coverage/coverage-summary.json'],
  ['extension', 'extension/coverage/coverage-summary.json'],
];
const metrics = ['statements', 'branches', 'functions', 'lines'];
const total = Object.fromEntries(metrics.map((metric) => [metric, { covered: 0, total: 0 }]));

console.log('\nRepository coverage (weighted by instrumented items)');
console.log('package\tstatements\tbranches\tfunctions\tlines');
for (const [name, file] of packages) {
  const summary = JSON.parse(await readFile(file, 'utf8')).total;
  console.log(`${name}\t${metrics.map((metric) => `${summary[metric].pct}%`).join('\t')}`);
  for (const metric of metrics) {
    total[metric].covered += summary[metric].covered;
    total[metric].total += summary[metric].total;
  }
}
const pct = (value) => value.total === 0 ? 100 : Math.floor(value.covered * 10000 / value.total) / 100;
const result = Object.fromEntries(metrics.map((metric) => [metric, pct(total[metric])]));
console.log(`total\t${metrics.map((metric) => `${result[metric]}%`).join('\t')}`);

const baseline = { statements: 66.4, branches: 59.1, functions: 82.9, lines: 68.2 };
const failures = metrics.filter((metric) => result[metric] < baseline[metric]);
if (failures.length) {
  for (const metric of failures) {
    console.error(`coverage regression: ${metric} ${result[metric]}% < ${baseline[metric]}%`);
  }
  process.exitCode = 1;
}
