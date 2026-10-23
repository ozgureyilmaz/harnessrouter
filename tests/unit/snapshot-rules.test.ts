import assert from 'node:assert/strict';
import test from 'node:test';
import {darwinSystemAlias, protectedWorkspacePath} from '../../src/workspace/snapshot.js';

const cases: Array<[string, boolean]> = [
  ['src/hooks/useAuth.ts', false],
  ['app/api/auth/[...nextauth]/route.ts', false],
  ['packages/tokens/index.ts', false],
  ['src/lib/secrets-manager.ts', false],
  ['src/token-utils.ts', false],
  ['docs/agents.md', false],
  ['hooks/pre-run.sh', false],
  ['src/app.ts', false],
  ['.dev.vars', true],
  ['terraform.tfstate', true],
  ['terraform.tfstate.backup', true],
  ['prod.tfvars', true],
  ['service-account-app.json', true],
  ['project-adminsdk-key.json', true],
  ['gcp-key-prod.json', true],
  ['.pgpass', true],
  ['.htpasswd', true],
  ['.kube/config', true],
  ['home/.kube/config', true],
  ['.docker/config.json', true],
  ['.yarnrc.yml', true],
  ['.npmrc', true],
  ['.netrc', true],
  ['certs/server.pem', true],
  ['certs/client.p12', true],
  ['certs/client.pfx', true],
  ['id_rsa', true],
  ['id_rsa.pub', true],
  ['id_ed25519', true],
  ['id_ed25519.pub', true],
  ['.env', true],
  ['.env.local', true],
  ['.env.example', false],
  ['.env.sample', false],
  ['.git/config', true],
  ['.git/hooks/pre-commit', true],
  ['.husky/pre-commit', true],
  ['node_modules/pkg/index.js', true],
  ['.harnessrouter/config.json', true],
  ['credentials.json', true],
  ['SYSTEM.md', true],
  ['.mcp.json', true],
  ['secrets.json', true],
];

test('snapshot rules include ordinary source and exclude secret and control paths', () => {
  for (const [path, excluded] of cases) {
    assert.equal(protectedWorkspacePath(path), excluded, path);
  }
});

test('snapshot include can restore a secret file and can never restore .git', () => {
  assert.equal(protectedWorkspacePath('.env', {include: ['.env']}), false);
  assert.equal(protectedWorkspacePath('.git/config', {include: ['**', '.git/**', '.git/config']}), true);
  assert.equal(protectedWorkspacePath('.git/hooks/pre-commit', {include: ['**']}), true);
  assert.equal(protectedWorkspacePath('src/local.log', {exclude: ['*.log']}), true);
  assert.equal(protectedWorkspacePath('notes.txt', {exclude: ['notes.txt']}), true);
  assert.equal(protectedWorkspacePath('src/hooks/useAuth.ts', {exclude: ['**/*.ts']}), true);
});

test('only the macOS system temp aliases have an accepted symlink target', () => {
  assert.equal(darwinSystemAlias('/var', 'private/var'), '/private/var');
  assert.equal(darwinSystemAlias('/tmp', '/private/tmp'), '/private/tmp');
  assert.equal(darwinSystemAlias('/var', '/tmp'), undefined);
  assert.equal(darwinSystemAlias('/var', '../etc'), undefined);
  assert.equal(darwinSystemAlias('/Users/me/project', 'private/var'), undefined);
  assert.equal(darwinSystemAlias('/private/var', 'somewhere'), undefined);
});
