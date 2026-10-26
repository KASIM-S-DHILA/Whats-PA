import asyncio
import hashlib
import hmac
import json
import unittest
from agent_memory import MemoryCallRequests, MemoryAssistant, MemoryVoiceTools, MEMORY_PROMPT


class Tools:
    def __init__(self):
        self.calls = []
        self.memory = []
        self.wait = asyncio.Event()
        self.wait.set()
        self.result = {'confirmed': True, 'outcome': 'found', 'records': []}

    async def request(self, action, revision, name=None, args=None, user_text=None, previous_reply=None):
        self.calls.append((action, revision, name))
        return {'confirmed': True}

    async def memory_request(self, action, revision, args, user_text):
        self.memory.append((action, revision, args, user_text))
        await self.wait.wait()
        return self.result


def spoken(requests, text):
    requests.speech_started()
    requests.transcript(text)


class MemoryAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_recall_sends_the_actual_transcript_and_a_fresh_revision(self):
        tools = Tools(); requests = MemoryCallRequests(tools)
        spoken(requests, 'What language do you remember for me?')
        result = await requests.run_memory('recall', {'scope': 'global', 'keys': ['language']})
        self.assertTrue(result['confirmed'])
        self.assertEqual(tools.memory, [('recall', 1, {'scope': 'global', 'keys': ['language']}, 'What language do you remember for me?')])
        await requests.close()

    async def test_without_a_spoken_request_nothing_is_sent(self):
        tools = Tools(); requests = MemoryCallRequests(tools)
        self.assertEqual((await requests.run_memory('forget', {'scope': 'global', 'key': 'language', 'evidenceQuote': 'forget it'}))['error'], 'missing_spoken_request')
        self.assertEqual(tools.memory, [])
        await requests.close()

    async def test_a_new_utterance_makes_an_earlier_request_stale(self):
        tools = Tools(); requests = MemoryCallRequests(tools)
        requests.speech_started()
        task = asyncio.create_task(requests.run_memory('recall', {'scope': 'global', 'keys': ['language']}))
        await asyncio.sleep(.01)
        requests.speech_started(); requests.transcript('something else')
        self.assertEqual((await task)['error'], 'stale_request')
        self.assertEqual(tools.memory, [])
        await requests.close()

    async def test_retry_of_the_same_utterance_is_answered_once(self):
        tools = Tools(); requests = MemoryCallRequests(tools)
        spoken(requests, 'Please forget my language preference')
        args = {'scope': 'global', 'key': 'language', 'evidenceQuote': 'forget my language preference'}
        tools.result = {'confirmed': True, 'state': 'forgotten'}
        first = await requests.run_memory('forget', args)
        second = await requests.run_memory('forget', args)
        self.assertEqual(first, second)
        self.assertEqual(len(tools.memory), 1)
        await requests.close()

    async def test_a_forget_in_flight_cannot_be_recalled_and_blocks_other_actions(self):
        tools = Tools(); tools.wait.clear(); requests = MemoryCallRequests(tools)
        spoken(requests, 'Forget my language preference')
        task = asyncio.create_task(requests.run_memory('forget', {'scope': 'global', 'key': 'language', 'evidenceQuote': 'Forget my language preference'}))
        await asyncio.sleep(.01)
        cancelled = await requests.cancel_current()
        self.assertEqual(cancelled['state'], 'commit_started')
        self.assertEqual((await requests.run_memory('recall', {'scope': 'global', 'keys': ['language']}))['state'], 'action_pending')
        tools.wait.set()
        self.assertTrue((await task)['confirmed'])
        await requests.close()

    async def test_recall_can_be_cancelled_by_an_explicit_stop(self):
        tools = Tools(); tools.wait.clear(); requests = MemoryCallRequests(tools)
        spoken(requests, 'What do you remember?')
        task = asyncio.create_task(requests.run_memory('recall', {'scope': 'global', 'keys': ['language']}))
        await asyncio.sleep(.01)
        requests.speech_started(); requests.transcript('Cancel that')
        with self.assertRaises(asyncio.CancelledError): await task
        await requests.close()

    async def test_errors_are_unconfirmed_and_not_cached(self):
        tools = Tools(); requests = MemoryCallRequests(tools)
        spoken(requests, 'What language do you remember?')
        tools.result = {'error': 'disabled', 'confirmed': False}
        self.assertEqual((await requests.run_memory('recall', {'scope': 'global', 'keys': ['language']}))['error'], 'disabled')
        tools.result = {'confirmed': True, 'outcome': 'found', 'records': []}
        self.assertTrue((await requests.run_memory('recall', {'scope': 'global', 'keys': ['language']}))['confirmed'])
        self.assertEqual(len(tools.memory), 2)
        await requests.close()

    async def test_tool_arguments_are_checked_before_any_request(self):
        tools = Tools(); requests = MemoryCallRequests(tools)
        agent = MemoryAssistant(requests)
        spoken(requests, 'What do you remember?')
        for call in (agent.recall_memory(None, ['home_address']), agent.recall_memory(None, ['language'], 'channel:chat'), agent.recall_memory(None, [])):
            self.assertEqual((await call)['error'], 'invalid_memory_read')
        self.assertEqual((await agent.forget_memory(None, 'password', 'forget my password'))['error'], 'invalid_memory_forget_request')
        self.assertEqual((await agent.forget_memory(None, 'language', 'no'))['error'], 'invalid_memory_forget_request')
        self.assertEqual(tools.memory, [])
        await requests.close()

    async def test_history_is_off_unless_enabled_and_records_only_final_caller_words(self):
        tools = Tools(); requests = MemoryCallRequests(tools, record_history=False)
        spoken(requests, 'Save a note about milk'); await asyncio.sleep(.01)
        self.assertEqual(tools.memory, [])
        on = Tools(); requests = MemoryCallRequests(on, record_history=True)
        requests.speech_started(); requests.transcript('  Save a note about milk  ')
        requests.speech_started(); requests.transcript('x' * 2500)
        await asyncio.sleep(.02)
        self.assertEqual([(a, args, len(text)) for a, _, args, text in on.memory], [('record_turn', {'utterance': 1}, 22), ('record_turn', {'utterance': 2}, 2000)])
        self.assertEqual(on.memory[0][3], 'Save a note about milk')
        await requests.close()

    async def test_history_stops_after_the_worker_reports_it_disabled(self):
        tools = Tools(); tools.result = {'error': 'history_disabled', 'confirmed': False}
        requests = MemoryCallRequests(tools, record_history=True)
        spoken(requests, 'first'); await asyncio.sleep(.02)
        spoken(requests, 'second'); await asyncio.sleep(.02)
        self.assertEqual(len(tools.memory), 1)
        self.assertFalse(requests.record_history)
        await requests.close()

    async def test_recall_history_is_bounded_and_sends_the_spoken_question(self):
        tools = Tools(); requests = MemoryCallRequests(tools, record_history=False)
        agent = MemoryAssistant(requests)
        spoken(requests, 'What did we talk about last time?')
        self.assertEqual((await agent.recall_history(None, 9))['error'], 'invalid_history_read')
        self.assertEqual(tools.memory, [])
        tools.result = {'confirmed': True, 'outcome': 'none', 'calls': []}
        self.assertTrue((await agent.recall_history(None, 2))['confirmed'])
        self.assertEqual(tools.memory, [('history', 1, {'limit': 2}, 'What did we talk about last time?')])
        await requests.close()

    async def test_search_documents_sends_a_bounded_query_with_the_spoken_words(self):
        tools = Tools(); requests = MemoryCallRequests(tools, record_history=False)
        agent = MemoryAssistant(requests)
        spoken(requests, 'What is the refund window in my policy?')
        for bad in ('', '   ', 'x' * 301):
            self.assertEqual((await agent.search_documents(None, bad))['error'], 'invalid_documents_query')
        self.assertEqual(tools.memory, [])
        tools.result = {'confirmed': True, 'outcome': 'no_evidence', 'passages': []}
        self.assertTrue((await agent.search_documents(None, '  refund window  '))['confirmed'])
        self.assertEqual(tools.memory, [('documents', 1, {'query': 'refund window'}, 'What is the refund window in my policy?')])
        await requests.close()

    def test_instructions_forbid_voice_saving_and_keep_the_original_rules(self):
        agent = MemoryAssistant(MemoryCallRequests(Tools()))
        text = str(agent.instructions)
        self.assertIn('Never claim a file or note was sent or saved without a confirmed result.', text)
        self.assertTrue(text.endswith(MEMORY_PROMPT))
        self.assertIn('cannot save new memories by voice', text)

    async def test_signed_request_has_the_memory_prefix_and_never_names_an_owner(self):
        captured = {}

        class Response:
            content = None
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False

        class Content:
            async def iter_chunked(self, n): yield b'{"confirmed":true}'

        class Http:
            def post(self, url, data, headers, allow_redirects, timeout):
                captured.update(url=url, data=data, headers=headers, redirects=allow_redirects)
                response = Response(); response.content = Content(); return response

        tools = MemoryVoiceTools(Http(), {'workerUrl': 'https://worker.example.invalid', 'secret': 'bridge-secret'}, 'wacid.test')
        result = await tools.memory_request('recall', 3, {'scope': 'global', 'keys': ['language']}, 'what language')
        self.assertTrue(result['confirmed'])
        self.assertEqual(captured['url'], 'https://worker.example.invalid/bridge/memory')
        self.assertFalse(captured['redirects'])
        stamp = captured['headers']['X-Bridge-Time']
        expected = hmac.new(b'bridge-secret', b'whats-memory-voice:v1:' + stamp.encode() + b':' + captured['data'], hashlib.sha256).hexdigest()
        self.assertEqual(captured['headers']['X-Bridge-Signature'], expected)
        self.assertEqual(sorted(json.loads(captured['data'])), ['action', 'args', 'callId', 'revision', 'userText'])


if __name__ == '__main__':
    unittest.main()
