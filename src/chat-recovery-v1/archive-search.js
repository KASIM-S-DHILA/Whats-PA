import {latestCallSummary} from './call-summary.js';
import {search_files as baseSearch} from '../search.js';
import {latestCallArchive} from './call-archive.js';

// Exact latest-call intents only; other file searches keep the existing path.
export async function search_files(env,owner,query,options){
 const match=/^(?:my )?(?:latest|last|most recent) (?:completed )?call (recording|transcript|summary)$/i.exec(query.trim());
 if(match?.[1].toLowerCase()==='summary')return latestCallSummary(env,owner);
 return match?latestCallArchive(env,owner,match[1].toLowerCase()):baseSearch(env,owner,query,options);
}
