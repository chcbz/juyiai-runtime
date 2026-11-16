import concurrent.futures
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
import urllib.error

spec = importlib.util.spec_from_file_location('audio_service', Path(__file__).with_name('service.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


def body(audio=b'fixture-only-bytes', model=s.MODEL):
    boundary = 'fixture-boundary'
    parts = []
    for name, value in [('file', audio), ('model', model.encode()), ('response_format', b'diarized_json')]:
        parts.append(b'--' + boundary.encode() + b'\r\nContent-Disposition: form-data; name="' + name.encode() + b'"\r\n\r\n' + value + b'\r\n')
    return 'multipart/form-data; boundary=' + boundary, b''.join(parts) + b'--' + boundary.encode() + b'--\r\n'


class TestAdapter(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.calls = []
        def engine(audio, language):
            self.calls.append((audio, language))
            return {'text': 'fixture protocol result', 'segments': [{'speaker': 'SPEAKER_00'}]}
        self.adapter = s.Adapter('fixture-secret', self.tmp.name, engine, 'fixed-inputs')

    def test_word_alignment_splits_cross_speaker_segment(self):
        turns = [{'start': 0, 'end': 1, 'speaker': 'A'}, {'start': 1, 'end': 2, 'speaker': 'B'}]
        rows, words = s.align_words([{'words': [{'start': 0, 'end': .8, 'word': '甲'}, {'start': 1.2, 'end': 1.9, 'word': '乙'}]}], turns)
        self.assertEqual([(r['speaker'], r['text']) for r in rows], [('A', '甲'), ('B', '乙')])
        self.assertEqual(len(words), 2)

    def test_unknown_is_not_invented_and_segment_fallback_retained(self):
        rows, _ = s.align_words([{'start': 0, 'end': 1, 'text': 'x'}], [])
        self.assertEqual(rows[0]['speaker'], 'UNKNOWN')

    def test_cache_is_bound_to_audio_language_and_model_fingerprint(self):
        a = self.adapter.transcribe(b'one', 'zh')
        self.assertEqual(a, self.adapter.transcribe(b'one', 'zh'))
        self.assertEqual(len(self.calls), 1)
        self.adapter.transcribe(b'two', 'zh')
        self.adapter.transcribe(b'one', 'en')
        changed = s.Adapter('fixture-secret', self.tmp.name, self.adapter.engine, 'changed-model')
        changed.transcribe(b'one', 'zh')
        self.assertEqual(len(self.calls), 4)
        for file in Path(self.tmp.name).glob('*.json'):
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_duplicate_concurrent_requests_share_one_inference(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.adapter.transcribe(b'same', None), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(len(self.calls), 1)

    def test_failed_engine_does_not_cache_fake_success(self):
        self.adapter.engine = lambda *_: (_ for _ in ()).throw(ValueError('failure'))
        with self.assertRaises(ValueError):
            self.adapter.transcribe(b'x', None)
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_multipart_exact_protocol(self):
        content, data = body()
        self.assertEqual(s.multipart(content, data), (b'fixture-only-bytes', None))
        for content, data in [body(audio=b''), body(model='wrong'), ('application/json', b'{}')]:
            with self.assertRaises(ValueError):
                s.multipart(content, data)

    def server(self):
        server = s.ThreadingHTTPServer(('127.0.0.1', 0), s.handler(self.adapter))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return 'http://127.0.0.1:' + str(server.server_port)

    def test_http_auth_rejects_before_inference(self):
        url = self.server()
        content, data = body()
        request = urllib.request.Request(url + '/v1/audio/transcriptions', data=data, headers={'Content-Type': content})
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(error.exception.code, 401)
        self.assertEqual(self.calls, [])

    def test_http_streaming_json_is_compatible_and_has_receipt(self):
        url = self.server()
        content, data = body()
        request = urllib.request.Request(url + '/v1/audio/transcriptions', data=data, headers={'Content-Type': content, 'Authorization': 'Bearer fixture-secret'})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers['Transfer-Encoding'], 'chunked')
            self.assertEqual(json.load(response)['text'], 'fixture protocol result')
            self.assertTrue(response.headers['X-Request-Id'])

    def test_http_failure_is_error_not_transcript(self):
        self.adapter.engine = lambda *_: (_ for _ in ()).throw(ValueError('private data'))
        url = self.server()
        content, data = body()
        request = urllib.request.Request(url + '/v1/audio/transcriptions', data=data, headers={'Content-Type': content, 'Authorization': 'Bearer fixture-secret'})
        with urllib.request.urlopen(request) as response:
            result = json.load(response)
        self.assertNotIn('text', result)
        self.assertNotIn('private data', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
