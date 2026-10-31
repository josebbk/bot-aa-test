// Serves site/ on a random localhost port and prints the URL (used by nojs.sh --dry-run).
import { serveSite } from './lib.mjs';

const { url } = await serveSite();
console.log(url);
