// backend/scripts/scan-tenant-queries.js
//
// Heuristic audit: lists SQL string literals in routes/ and lib/ that read or
// write a table carrying company_id without mentioning company_id. Most hits
// are legitimate (child rows reached through an already-scoped parent id, the
// caller's own user row, platform-admin views); review new hits by hand.
//
//   node scripts/scan-tenant-queries.js <path-to-a-migrated.sqlite>
//
// Run from backend/. Output: file:line, BY_ID|OTHER, tables, query excerpt.
const fs=require('fs'),path=require('path');
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2]);
const tenant=db.prepare("select name from sqlite_master where type='table'").all().map(r=>r.name)
 .filter(t=>db.prepare(`pragma table_info(${t})`).all().some(c=>c.name==='company_id'));
const re=/(`[^`]*`|'[^'\n]*'|"[^"\n]*")/g;
for(const dir of ['routes','lib']) for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.js'))){
  const src=fs.readFileSync(path.join(dir,f),'utf8');
  let m; while((m=re.exec(src))){
    const q=m[0];
    if(!/\b(SELECT|UPDATE|DELETE)\b/i.test(q)) continue;
    const tabs=[...q.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+(\w+)/gi)].map(x=>x[1]).filter(t=>tenant.includes(t));
    if(!tabs.length||/company_id/.test(q)) continue;
    const line=src.slice(0,m.index).split('\n').length;
    const byId=/WHERE\s+(\w+\.)?id\s*=\s*\?/i.test(q);
    console.log(`${dir}/${f}:${line}\t${byId?'BY_ID':'OTHER'}\t${tabs.join(',')}\t${q.replace(/\s+/g,' ').slice(0,110)}`);
  }
}
