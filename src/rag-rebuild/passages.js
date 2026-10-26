import {passages as splitPassages} from '../rag-v1/core.js';
const ignored=new Set('a an the and or to of for from in on at is are was were be do does did what which how please tell me my this that about say says explain summarize summary'.split(' '));
const words=text=>text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu)??[];
export function findPassages(text,query){
 const range=query.match(/\b(?:checks?|items?|steps?|sections?)\s+(\d{1,3})\s*(?:to|through|[-–—])\s*(\d{1,3})\b/iu);
 if(range){
  const first=Number(range[1]),last=Number(range[2]);
  if(first<1||last<first||last-first>=5)return {state:'range_too_large',passages:[]};
  const labels=[...text.matchAll(/^[ \t]*(\d{1,3})[.)]?[ \t]*\r?\n/gm)];
  const matches=labels.map((label,index)=>({label,index})).filter(({index})=>Array.from({length:last-first+1},(_,offset)=>Number(labels[index+offset]?.[1])===first+offset).every(Boolean));
  if(matches.length>1)return {state:'ambiguous_range',passages:[]};
  if(!matches.length)return {state:'range_missing',passages:[]};
  const {label,index}=matches[0],start=label.index,end=labels[index+last-first+1]?.index??text.length;
  if(end-start>2400)return {state:'range_too_large',passages:[]};
  const heading=[...text.slice(0,start).matchAll(/^#{1,6}[ \t]+([^\r\n]+).*$/gm)].at(-1)?.[1]??'';
  return {state:'matched',method:'numbered_range',passages:[{position:index,start,end,heading,content:text.slice(start,end)}]};
 }
 const terms=[...new Set(words(query).filter(w=>!ignored.has(w)))];
 if(!terms.length||terms.length>24)return {state:'query_needed',passages:[]};
 const matches=splitPassages(text,{maxChars:1200}).map(p=>{
  const counts=new Map();for(const word of words(p.content))counts.set(word,(counts.get(word)??0)+1);
  return {...p,score:terms.every(t=>counts.has(t))?terms.reduce((n,t)=>n+Math.min(counts.get(t),3),0):0};
 }).filter(p=>p.score>0).sort((a,b)=>b.score-a.score||a.position-b.position).slice(0,2);
 return {state:matches.length?'matched':'no_match',passages:matches};
}
