// Starts a throwaway Directus with this extension, runs e2e.mjs, then removes it.
// Usage: npm run test:e2e             (Postgres)
//        E2E_DB=mysql npm run test:e2e   (postgres, mysql, mariadb or sqlite)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const engine = process.env.E2E_DB || 'postgres';
const engines = {
	postgres: { image: 'postgres:16.3', client: 'pg', port: '5432' },
	mysql: { image: 'mysql:8.4', client: 'mysql', port: '3306' },
	mariadb: { image: 'mariadb:11', client: 'mysql', port: '3306' },
	sqlite: { client: 'sqlite3' },
};
const db = engines[engine];
if (!db) throw new Error(`Unknown E2E_DB: ${engine}`);

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'directus-e2e-'));
for (const dir of ['uploads', 'uploads2', 'extensions', 'database']) {
	fs.mkdirSync(path.join(data, dir), { recursive: true });
	fs.chmodSync(path.join(data, dir), 0o777);
}
const target = path.join(data, 'extensions', manifest.name);
fs.mkdirSync(target);
fs.copyFileSync(path.join(root, 'package.json'), path.join(target, 'package.json'));
fs.cpSync(path.join(root, 'dist'), path.join(target, 'dist'), { recursive: true });

const port = process.env.E2E_PORT || '8098';
const env = {
	...process.env,
	E2E_DATA: data,
	E2E_PORT: port,
	E2E_URL: `http://127.0.0.1:${port}`,
	DB_IMAGE: db.image || 'postgres:16.3',
	DB_CLIENT: db.client,
	DB_HOST: 'db',
	DB_PORT: db.port || '',
	COMPOSE_PROFILES: db.image ? engine : '',
};
const compose = (...args) =>
	execFileSync('docker', ['compose', '-p', `e2e-${manifest.name}`, '-f', path.join(here, 'docker-compose.yml'), ...args], {
		env,
		stdio: 'inherit',
	});

let status = 1;
try {
	compose('up', '-d', '--build', '--quiet-pull');
	let ready = false;
	for (let i = 0; i < 80 && !ready; i++) {
		ready = await fetch(`${env.E2E_URL}/server/ping`).then((r) => r.ok, () => false);
		if (!ready) await new Promise((resolve) => setTimeout(resolve, 3000));
	}
	if (!ready) throw new Error('Directus did not start');
	status = spawnSync(process.execPath, [path.join(here, 'e2e.mjs')], { env, stdio: 'inherit' }).status ?? 1;
} finally {
	compose('down', '-v', '--remove-orphans');
	console.log(`Test files are in ${data}`);
}
process.exit(status);
