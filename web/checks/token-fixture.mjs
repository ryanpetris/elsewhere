import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function createToken(root, permissions) {
  const { stdout } = await exec(process.env.ELSEWHERE_BINARY || '/src/target/release/elsewhere', ['token', 'create', '--admin'], {
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root + '/config' },
  });
  const token = stdout.trim();
  if (permissions) {
    await exec('python3', ['-c', `import hashlib,json,sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    token_id = db.execute('SELECT id FROM tokens WHERE secret_hash=?', (hashlib.sha256(sys.argv[2].encode()).digest(),)).fetchone()[0]
    grants = json.loads(sys.argv[3])
    for permission, in db.execute('SELECT permission FROM token_permissions WHERE token_id=?', (token_id,)).fetchall():
        if permission not in grants: db.execute('DELETE FROM token_permissions WHERE token_id=? AND permission=?', (token_id,permission))
`, root + '/config/elsewhere/state.sqlite3', token, JSON.stringify(permissions)]);
  }
  return token;
}
export async function revokeToken(origin, token) {
  const headers = { Authorization: 'Bearer ' + token };
  const { metadata } = await (await fetch(origin + '/api/me', { headers })).json();
  return fetch(origin + '/api/tokens/' + metadata.id, { method: 'DELETE', headers });
}
