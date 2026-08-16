import { normKey } from '../src/core/text.js';
for (const h of ['Date','District','Price ($psf)','Price ($)','Area (sq ft)','Type of Area','URA Zoning ','No. of Floors','GPR']) {
  console.log(JSON.stringify(h).padEnd(22), '->', JSON.stringify(normKey(h)));
}
console.log('lookup keys:');
for (const n of ['price psf','price','area sq ft','type of area','ura zoning']) {
  console.log('  ', JSON.stringify(n), '->', JSON.stringify(normKey(n)));
}
