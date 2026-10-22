// Demonstration only: no real credential, subprocess, or network access.
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !['--plain', '--json'].includes(args[0]))) {
  process.stderr.write('Usage: node mint-demo.mjs [--plain|--json]\n');
  process.exitCode = 2;
} else {
  const apiKey = 'EXAMPLE_ONLY_NOT_A_REAL_KEY';
  process.stdout.write(args[0] === '--json'
    ? JSON.stringify({ apiKey, expiresIn: 300 }) + '\n'
    : apiKey + '\n');
}
