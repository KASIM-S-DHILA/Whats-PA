import asyncio
import json
import sqlite3
import time
from pathlib import Path
import aiohttp

ROOT=Path(__file__).resolve().parents[1]
async def main():
    settings=json.loads((ROOT/'.local/bridge/live-config.json').read_text())
    report={'checkedAtEpoch':time.time(),'source':'LOCAL_LIVE_BRIDGE_HEALTH_AND_SANITIZED_PER_CALL_TRANSCRIPT_COUNTS; NO_RAW_TRANSCRIPT_CALL_ID_KEY_OR_RESUMPTION_HANDLE_EXPORTED','model':settings['model']}
    async with aiohttp.ClientSession() as client:
        async with client.get('http://127.0.0.1:7860/health',timeout=aiohttp.ClientTimeout(total=3)) as response:
            report['health']=await response.json()
    db=sqlite3.connect('file:'+str(ROOT/'.local/bridge/calls.sqlite').replace('\\','/')+'?mode=ro',uri=True)
    has_transcripts=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcripts'").fetchone()
    rows=db.execute('SELECT id,state,updated FROM calls WHERE updated>=? ORDER BY updated',(settings['activatedAtEpoch'],)).fetchall()
    calls=[]
    cache_path=ROOT/'.local/bridge/live-accepted-times.json'
    accepted=json.loads(cache_path.read_text()) if cache_path.exists() else {}
    for n,(id,state,updated) in enumerate(rows):
        if state=='accepted':accepted[id]=updated
        counts=db.execute('SELECT role,COUNT(*),SUM(length(text)),SUM(interrupted) FROM transcripts WHERE call_id=? GROUP BY role',(id,)).fetchall() if has_transcripts else []
        calls.append({'ordinal':n+1,'state':state,'updatedAtEpoch':updated,'acceptedAtEpoch':accepted.get(id),'acceptedToCleanupSeconds':round(updated-accepted[id],3) if state=='terminated' and id in accepted else None,'transcripts':[{'role':role,'chunks':chunks,'characters':chars,'interruptedChunks':interrupted} for role,chunks,chars,interrupted in counts]})
    cache_path.write_text(json.dumps(accepted)+'\n')
    db.close();report['calls']=calls
    if report['health']['completedCalls']>0:
        report['media']=json.loads((ROOT/'.local/bridge/metrics.json').read_text())
    (ROOT/'evidence/phase6/live-evidence.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))

asyncio.run(main())
