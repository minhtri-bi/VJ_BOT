import {createHash} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export const sha256=value=>createHash('sha256').update(value).digest('hex');
const fileHash=(root,file)=>sha256(readFileSync(resolve(root,file)));

export function checkoutIdentity(root) {
  const files=['package.json','package-lock.json', ...['src','migrations'].flatMap(dir=>
    readdirSync(resolve(root,dir),{recursive:true}).map(name=>`${dir}/${name.replaceAll('\\','/')}`)
      .filter(file=>/\.(?:[cm]?js|json|sql)$/.test(file) && file!=='src/prompt.js'))].sort();
  return {revision:fileHash(root,'src/prompt.js'),
    runtime_digest:sha256(JSON.stringify(files.map(file=>[file,fileHash(root,file)])))};
}
