/** Transfer only the explicitly supplied connector token; never copy an entire developer env. */
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';

const file = process.argv[2] ?? '.env';
const token = parseEnv(await readFile(file, 'utf8')).RECORDS_CLOUDFLARE_TUNNEL_TOKEN;
if (!token || !/^[A-Za-z0-9_+/=-]{100,8192}$/.test(token)) {
  throw new Error('The selected environment file needs a valid RECORDS_CLOUDFLARE_TUNNEL_TOKEN.');
}
// Fixed reviewed target. SSH checks the existing host key; no relaxed verification or secret argv.
const remote = `set -eu
umask 077
target="$HOME/containers/records/secrets"
test -d "$target"
test ! -L "$target"
temporary=$(mktemp "$target/.tunnel_token.XXXXXX")
trap 'rm -f "$temporary"' EXIT
cat > "$temporary"
chmod 600 "$temporary"
mv -f "$temporary" "$target/tunnel_token"
`;
const child = spawn('ssh', ['-o', 'BatchMode=yes', 'ms', remote], { stdio: ['pipe', 'ignore', 'pipe'] });
// Do not print remote output on error: neither local nor remote failures may reveal a token.
child.stderr.resume();
child.stdin.on('error', () => { /* SSH exit is reported below without secret material. */ });
child.stdin.end(token + '\n');
await new Promise<void>((resolve, reject) => {
  child.once('error', () => reject(new Error('Unable to start secure token transfer')));
  child.once('exit', code => code === 0 ? resolve() : reject(new Error('Secure token transfer failed')));
});
console.log('Installed the tunnel token on ms with mode 0600; no other environment values transferred.');
