// End-to-end checks against a real Directus. Run with `npm run test:e2e`.
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';

const B = process.env.E2E_URL;
const UP = path.join(process.env.E2E_DATA, 'uploads');
let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
	condition ? pass++ : fail++;
	console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : `  -> ${JSON.stringify(detail).slice(0, 300)}`}`);
};
const j = async (method, url, body, headers = {}, token = T) => {
	const response = await fetch(B + url, {
		method,
		headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = text;
	}
	return { s: response.status, d: data };
};
let T = null;
T = (await j('POST', '/auth/login', { email: 'admin@example.com', password: 'e2e-password' })).d.data.access_token;
const mk = async (collection, fields) => {
	const r = await j('POST', '/collections', { collection, schema: {}, meta: {}, fields });
	if (r.s !== 200) console.log('could not create', collection, JSON.stringify(r.d));
};
const uuidPk = { field: 'id', type: 'uuid', schema: { is_primary_key: true }, meta: { special: ['uuid'], hidden: true } };
const intPk = { field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true }, meta: {} };

await mk('pairs',[uuidPk,{field:'date_created',type:'timestamp',schema:{},meta:{special:['date-created']}},{field:'x',type:'integer',schema:{},meta:{}},{field:'y',type:'integer',schema:{},meta:{}}]);
const P=[];for(const r of [{x:1,y:null},{x:1,y:null},{x:2,y:2}]){P.push((await j('POST','/items/pairs',r)).d.data.id);await new Promise(r=>setTimeout(r,20))}
await new Promise(r=>setTimeout(r,1100));const newest=(await j('POST','/items/pairs',{x:2,y:2})).d.data.id;
const chk=await j('POST','/composite-unique-endpoint/check',{collection:'pairs',fields:['x','y']});
ok('cu: NULL rows are not duplicates',chk.s==200&&chk.d.data.duplicateGroups.length==1&&chk.d.data.duplicateGroups[0].values.x==2,chk.d);
const ded=await j('POST','/composite-unique-endpoint/dedupe',{collection:'pairs',fields:['x','y'],strategy:'keep_first'});
const left=(await j('GET','/items/pairs?limit=-1')).d.data.map(r=>r.id);
ok('cu: keep_first keeps oldest, NULL rows survive',left.length==3&&left.includes(P[2])&&!left.includes(newest),{left,ded:ded.d});
const ap=await j('POST','/composite-unique-endpoint/apply',{collection:'pairs',fields:['x','y']});ok('cu: apply',ap.s==200,ap.d);
await new Promise(r=>setTimeout(r,5200));
const dup=await j('POST','/items/pairs',{x:2,y:2});
ok('cu: violation is 400 with message',dup.s==400&&/Composite unique/.test(JSON.stringify(dup.d)),dup);
ok('cu: NULL row still insertable',(await j('POST','/items/pairs',{x:1,y:null})).s==200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
