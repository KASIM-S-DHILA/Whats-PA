import asyncio
import hashlib
import hmac
import json
import unittest
from types import SimpleNamespace
from agent import CallRequests, verified_call, Assistant, CallerVADStream, bind_transcription
from livekit import rtc, agents

class Tools:
    def __init__(self):
        self.calls=[]
        self.wait=asyncio.Event()
        self.wait.set()
    async def request(self, action, revision, name=None, args=None, user_text=None, previous_reply=None):
        self.calls.append((action,revision,name,args,user_text,previous_reply))
        if action=='prepare':
            await self.wait.wait()
            return {'prepared':True}
        return {'confirmed':True}

class AgentTests(unittest.IsolatedAsyncioTestCase):
    def test_signed_dispatch_is_bound_to_exact_room_and_call(self):
        call='wacid.test';room='whats-'+hashlib.sha256(call.encode()).hexdigest()[:32]
        signature=hmac.new(b'secret',f'whats-livekit:v1:{call}:{room}'.encode(),hashlib.sha256).hexdigest()
        data=json.dumps({'callId':call,'room':room,'signature':signature})
        self.assertEqual(verified_call(data,room,'secret'),call)
        for target,secret in [('whats-other','secret'),(room,'wrong')]:
            with self.assertRaises(ValueError): verified_call(data,target,secret)

    async def test_commit_uses_actual_asr_and_returns_confirmation(self):
        tools=Tools();requests=CallRequests(tools)
        requests.speech_started();requests.transcript('Save a note saying buy coffee beans')
        context=SimpleNamespace(speech_handle=SimpleNamespace(interrupted=False))
        result=await requests.run(context,'log_note',{'text':'buy coffee beans'})
        self.assertTrue(result['confirmed'])
        self.assertEqual([x[0] for x in tools.calls].count('commit'),1)
        self.assertEqual(next(x[4] for x in tools.calls if x[0]=='prepare'),'Save a note saying buy coffee beans')
        await requests.close()

    async def test_explicit_cancellation_stops_slow_write_before_commit(self):
        tools=Tools();tools.wait.clear();requests=CallRequests(tools)
        requests.speech_started();requests.transcript('Save old note')
        context=SimpleNamespace(speech_handle=SimpleNamespace(interrupted=False))
        task=asyncio.create_task(requests.run(context,'log_note',{'text':'old note'}))
        await asyncio.sleep(.01)
        requests.speech_started();requests.transcript('Cancel that')
        with self.assertRaises(asyncio.CancelledError): await task
        await asyncio.sleep(.01)
        self.assertFalse(any(x[0]=='commit' for x in tools.calls))
        self.assertTrue(any(x[0]=='cancel' and x[1]==1 for x in tools.calls))
        await requests.close()

    async def test_model_interrupted_handle_does_not_block_current_caller_request(self):
        tools=Tools();requests=CallRequests(tools)
        requests.speech_started();requests.transcript('Send the first one')
        result=await requests.run(SimpleNamespace(speech_handle=SimpleNamespace(interrupted=True)),'get_file',{'fileId':'0'*16})
        self.assertTrue(result['confirmed'])
        self.assertTrue(any(x[0]=='commit' for x in tools.calls))
        await requests.close()

    async def test_close_sends_one_end_and_rejects_more_tools(self):
        tools=Tools();requests=CallRequests(tools)
        await requests.close();await requests.close()
        self.assertEqual([x[0] for x in tools.calls].count('end'),1)
        result=await requests.run(None,'search_files',{'query':'test'})
        self.assertFalse(result['confirmed'])

    def test_sdk_discovers_three_actions_and_cancellation(self):
        assistant=Assistant(CallRequests(Tools()))
        self.assertEqual(len(assistant.tools),4)

    async def test_model_speaking_event_does_not_cancel_pending_work(self):
        tools=Tools();tools.wait.clear();requests=CallRequests(tools)
        session=rtc.EventEmitter();bind_transcription(session,requests)
        requests.speech_started()
        session.emit('user_input_transcribed',SimpleNamespace(is_final=True,transcript='Find security checklist'))
        context=SimpleNamespace(speech_handle=SimpleNamespace(interrupted=False))
        task=asyncio.create_task(requests.run(context,'search_files',{'query':'security'}))
        await asyncio.sleep(.01)
        session.emit('user_state_changed',SimpleNamespace(new_state='speaking'))
        self.assertFalse(task.done());self.assertEqual(requests.revision,1)
        tools.wait.set();result=await task;self.assertTrue(result['confirmed'])
        await requests.close()

    async def test_only_caller_vad_start_advances_revision(self):
        events=[SimpleNamespace(type=kind) for kind in [agents.vad.VADEventType.INFERENCE_DONE,agents.vad.VADEventType.START_OF_SPEECH,agents.vad.VADEventType.END_OF_SPEECH]]
        class Source:
            async def __anext__(self):
                if not events:raise StopAsyncIteration
                return events.pop(0)
        started=[];stream=CallerVADStream(Source(),lambda:started.append(True))
        received=[event.type async for event in stream]
        self.assertEqual(len(received),3);self.assertEqual(started,[True])

if __name__=='__main__': unittest.main()

class ContextTests(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_find_and_send_reuses_original_asr_in_dependent_steps(self):
        tools=Tools();original=tools.request
        async def request(action,revision,name=None,*args,**kwargs):
            result=await original(action,revision,name,*args,**kwargs)
            if action=='prepare' and name=='search_files':
                return {'files':[{'fileId':'0'*16,'bestMatch':True}], 'ambiguous':False}
            return result
        tools.request=request;requests=CallRequests(tools)
        requests.speech_started();requests.transcript('Find and send my security PDF')
        result=await requests.run(None,'search_files',{'query':'security'},'send_best')
        self.assertTrue(result['confirmed'])
        prepared=[call for call in tools.calls if call[0]=='prepare']
        self.assertEqual([call[2] for call in prepared],['search_files','get_file'])
        self.assertEqual([call[1] for call in prepared],[1,1])
        self.assertEqual([call[4] for call in prepared],['Find and send my security PDF']*2)
        await requests.close()

    async def test_ambiguous_compound_search_does_not_send_any_file(self):
        tools=Tools();original=tools.request
        async def request(action,*args,**kwargs):
            await original(action,*args,**kwargs)
            return {'files':[{'fileId':'0'*16,'bestMatch':False}], 'ambiguous':True}
        tools.request=request;requests=CallRequests(tools)
        requests.speech_started();requests.transcript('Find and send security PDF')
        result=await requests.run(None,'search_files',{'query':'security'},'send_best')
        self.assertEqual(result['delivery'],'needs_selection')
        self.assertFalse(any(call[2]=='get_file' for call in tools.calls))
        await requests.close()

    async def test_save_only_never_shares_but_explicit_save_and_share_does(self):
        for followup,expected in [(None,0),('share_note',1)]:
            tools=Tools();original=tools.request
            async def request(action,*args,**kwargs):
                result=await original(action,*args,**kwargs)
                return {**result,'fileId':'0'*16} if action=='commit' else result
            tools.request=request;requests=CallRequests(tools)
            requests.speech_started();requests.transcript('Save and send a note: beans' if followup else 'Save a note: beans')
            self.assertTrue((await requests.run(None,'log_note',{'text':'beans'},followup))['confirmed'])
            self.assertEqual(sum(call[0]=='prepare' and call[2]=='get_file' for call in tools.calls),expected)
            await requests.close()

    async def test_hello_does_not_cancel_upload_or_restart_action(self):
        tools=Tools();tools.wait.clear();requests=CallRequests(tools)
        requests.speech_started();requests.transcript('Send the PDF')
        updates=[]
        class Context:
            async def update(self,message): updates.append(message)
        task=asyncio.create_task(requests.run(Context(),'get_file',{'fileId':'0'*16}))
        await asyncio.sleep(.01)
        requests.speech_started();requests.transcript('Hello')
        self.assertFalse(task.done());self.assertEqual(requests.revision,1)
        self.assertFalse(any(x[0]=='advance' for x in tools.calls))
        tools.wait.set();self.assertTrue((await task)['confirmed'])
        self.assertEqual(len(updates),1);self.assertFalse(updates[0]['confirmed'])
        self.assertEqual(next(x[4] for x in tools.calls if x[0]=='prepare'),'Send the PDF')
        await requests.close()

    async def test_write_pauses_for_new_asr_and_hindi_stop_prevents_commit(self):
        tools=Tools();tools.wait.clear();requests=CallRequests(tools)
        requests.speech_started();requests.transcript('Save note: old note')
        task=asyncio.create_task(requests.run(None,'log_note',{'text':'old note'}))
        await asyncio.sleep(.01);requests.speech_started();tools.wait.set()
        await asyncio.sleep(.01)
        self.assertFalse(any(x[0]=='commit' for x in tools.calls))
        requests.transcript('मत भेजो')
        with self.assertRaises(asyncio.CancelledError):await task
        await asyncio.sleep(.01)
        self.assertTrue(any(x[0]=='advance' and x[1]==2 for x in tools.calls))
        self.assertFalse(any(x[0]=='commit' for x in tools.calls))
        await requests.close()

    async def test_gemini_correction_tool_cancels_then_new_request_can_run(self):
        tools=Tools();tools.wait.clear();requests=CallRequests(tools)
        requests.speech_started();requests.transcript('Save old note')
        task=asyncio.create_task(requests.run(None,'log_note',{'text':'old note'}))
        await asyncio.sleep(.01)
        requests.speech_started();requests.transcript('Actually save new note instead')
        cancelled=await requests.cancel_current();self.assertEqual(cancelled['state'],'cancelled_before_commit')
        self.assertTrue(task.cancelled());tools.wait.set()
        self.assertTrue((await requests.run(None,'log_note',{'text':'new note'}))['confirmed'])
        self.assertEqual(next(x[4] for x in tools.calls if x[0]=='prepare' and x[1]==3),'Actually save new note instead')
        await requests.close()

    async def test_duplicate_and_concurrent_actions_do_not_double_commit(self):
        tools=Tools();tools.wait.clear();requests=CallRequests(tools)
        requests.speech_started();requests.transcript('Save note: beans')
        task=asyncio.create_task(requests.run(None,'log_note',{'text':'beans'}))
        await asyncio.sleep(.01)
        duplicate=await requests.run(None,'log_note',{'text':'beans'})
        self.assertEqual(duplicate['state'],'action_pending')
        tools.wait.set();result=await task
        self.assertEqual(await requests.run(None,'log_note',{'text':'beans'}),result)
        self.assertEqual(sum(x[0]=='commit' for x in tools.calls),1)
        await requests.close()

    async def test_cancellation_after_commit_boundary_cannot_claim_undo(self):
        tools=Tools();gate=asyncio.Event();original=tools.request
        async def request(action,*args,**kwargs):
            if action=='commit':await gate.wait()
            return await original(action,*args,**kwargs)
        tools.request=request;requests=CallRequests(tools)
        requests.speech_started();requests.transcript('Send PDF')
        task=asyncio.create_task(requests.run(None,'get_file',{'fileId':'0'*16}))
        await asyncio.sleep(.01)
        self.assertEqual((await requests.cancel_current())['state'],'commit_started')
        gate.set();self.assertTrue((await task)['confirmed'])
        self.assertFalse(any(x[0]=='cancel' for x in tools.calls))
        await requests.close()

    async def test_hangup_invalidates_backend_and_stops_pending_work(self):
        tools=Tools();tools.wait.clear();requests=CallRequests(tools)
        requests.speech_started();requests.transcript('Save note: beans')
        task=asyncio.create_task(requests.run(None,'log_note',{'text':'beans'}))
        await asyncio.sleep(.01);await requests.close()
        self.assertTrue(task.cancelled())
        self.assertEqual(sum(x[0]=='end' for x in tools.calls),1)
        self.assertFalse(any(x[0]=='commit' for x in tools.calls))

    async def test_late_asr_cannot_authorize_an_earlier_tool_request(self):
        requests=CallRequests(Tools());requests.speech_started()
        task=asyncio.create_task(requests.run(None,'log_note',{'text':'old note'}))
        await asyncio.sleep(.01);requests.speech_started();requests.transcript('new request')
        self.assertEqual((await task)['error'],'stale_request')
        self.assertFalse(any(x[0]=='prepare' for x in requests.tools.calls))
        await requests.close()

    async def test_last_completed_assistant_reply_reaches_authorization(self):
        tools=Tools();requests=CallRequests(tools);session=rtc.EventEmitter()
        bind_transcription(session,requests)
        session.emit('conversation_item_added',SimpleNamespace(item=SimpleNamespace(role='assistant',interrupted=False,text_content='Would you like this PDF sent to WhatsApp?')))
        requests.speech_started();requests.transcript('हां, भेज दूंगा।')
        await requests.run(None,'get_file',{'fileId':'0'*16})
        prepare=next(x for x in tools.calls if x[0]=='prepare')
        self.assertEqual(prepare[5],'Would you like this PDF sent to WhatsApp?')
        session.emit('conversation_item_added',SimpleNamespace(item=SimpleNamespace(role='assistant',interrupted=True,text_content='Incomplete offer')))
        self.assertEqual(requests.previous_reply,'')
        session.emit('conversation_item_added',SimpleNamespace(item=SimpleNamespace(role='assistant',interrupted=False,text_content=None)))
        self.assertEqual(requests.previous_reply,'')
        await requests.close()
